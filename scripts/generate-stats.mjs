#!/usr/bin/env node
// Generates ./assets/stats.svg, top-langs.svg, streak.svg from the GitHub
// GraphQL API. Requires env STATS_TOKEN (PAT with `repo` + `read:user`) so it
// can include private repository data. Run locally or via GitHub Actions.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = process.env.STATS_TOKEN;
const USERNAME = process.env.STATS_USERNAME || 'daanrod';

if (!TOKEN) {
  console.error('STATS_TOKEN env var required');
  process.exit(1);
}

const THEME = {
  bg: '#0d1117',
  fg: '#e6edf3',
  muted: '#8b949e',
  accent: '#1f6feb',
  accentSoft: '#1f6feb33',
  fire: '#f78166',
};

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${USERNAME}-stats-generator`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

async function fetchUserBasics(login) {
  const data = await gql(
    `query($login: String!) {
      user(login: $login) {
        name
        login
        createdAt
        followers { totalCount }
        following { totalCount }
        pullRequests(states: [OPEN, CLOSED, MERGED]) { totalCount }
        issues { totalCount }
        contributionsCollection {
          totalCommitContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays { date contributionCount }
            }
          }
        }
      }
    }`,
    { login },
  );
  return data.user;
}

async function fetchAllRepos(login) {
  const all = [];
  let cursor = null;
  while (true) {
    const data = await gql(
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name
              isPrivate
              stargazerCount
              languages(first: 20, orderBy: {field: SIZE, direction: DESC}) {
                edges { size node { name color } }
              }
            }
          }
        }
      }`,
      { login, cursor },
    );
    const conn = data.user.repositories;
    all.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return all;
}

async function fetchLifetimeCommits(login, joinedAt) {
  // Iterate one year at a time. GraphQL contributionsCollection accepts a
  // window up to 1 year. Sum totalCommitContributions for each year.
  const startYear = new Date(joinedAt).getUTCFullYear();
  const endYear = new Date().getUTCFullYear();
  let total = 0;
  for (let y = startYear; y <= endYear; y++) {
    const from = `${y}-01-01T00:00:00Z`;
    const to = `${y}-12-31T23:59:59Z`;
    const data = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            restrictedContributionsCount
          }
        }
      }`,
      { login, from, to },
    );
    const cc = data.user.contributionsCollection;
    total += cc.totalCommitContributions + cc.restrictedContributionsCount;
  }
  return total;
}

function flattenDays(weeks) {
  return weeks
    .flatMap((w) => w.contributionDays)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function computeStreaks(weeks) {
  const days = flattenDays(weeks);
  const today = new Date().toISOString().slice(0, 10);

  let current = 0;
  let currentStart = null;
  let longest = 0;
  let longestStart = null;
  let longestEnd = null;
  let runStart = null;
  let runLen = 0;

  for (const d of days) {
    if (d.contributionCount > 0) {
      if (runLen === 0) runStart = d.date;
      runLen++;
      if (runLen > longest) {
        longest = runLen;
        longestStart = runStart;
        longestEnd = d.date;
      }
    } else {
      runLen = 0;
      runStart = null;
    }
  }

  // Current streak: walk backwards from today; allow today to be 0 (grace day)
  let started = false;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (!started && d.date === today && d.contributionCount === 0) continue;
    if (d.contributionCount > 0) {
      if (!started) currentStart = d.date;
      started = true;
      current++;
      currentStart = d.date;
    } else if (started) {
      break;
    }
  }

  return { current, currentStart, longest, longestStart, longestEnd };
}

function aggregateLanguages(repos) {
  const totals = {};
  for (const repo of repos) {
    for (const edge of repo.languages.edges) {
      const name = edge.node.name;
      if (!totals[name]) totals[name] = { size: 0, color: edge.node.color || '#8b949e' };
      totals[name].size += edge.size;
    }
  }
  const grand = Object.values(totals).reduce((s, v) => s + v.size, 0) || 1;
  return Object.entries(totals)
    .map(([name, v]) => ({ name, size: v.size, color: v.color, pct: (v.size / grand) * 100 }))
    .sort((a, b) => b.size - a.size);
}

// ----- SVG -----
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

function svgShell(width, height, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" role="img">
  <style>
    .bg { fill: ${THEME.bg}; }
    .title { fill: ${THEME.accent}; font: 600 18px ${FONT}; }
    .label { fill: ${THEME.fg}; font: 400 14px ${FONT}; }
    .value { fill: ${THEME.accent}; font: 700 14px ${FONT}; }
    .big { fill: ${THEME.fg}; font: 700 32px ${FONT}; }
    .muted { fill: ${THEME.muted}; font: 400 11px ${FONT}; }
    .icon { fill: ${THEME.accent}; }
  </style>
  <rect class="bg" width="${width}" height="${height}" rx="10" />
  ${inner}
</svg>`;
}

function statsSvg(user, repos, lifetimeCommits) {
  const totalStars = repos.reduce((s, r) => s + r.stargazerCount, 0);
  const totalContribs = user.contributionsCollection.contributionCalendar.totalContributions;
  const rows = [
    ['Total Stars Earned', totalStars],
    ['Total Commits (all-time)', lifetimeCommits],
    ['Total PRs', user.pullRequests.totalCount],
    ['Total Issues', user.issues.totalCount],
    ['Contributions (last year)', totalContribs],
    ['Repositories', repos.length],
    ['Followers', user.followers.totalCount],
  ];

  const items = rows
    .map(([label, value], i) => {
      const y = 70 + i * 22;
      return `
    <text x="25" y="${y}" class="label">${label}</text>
    <text x="375" y="${y}" class="value" text-anchor="end">${value.toLocaleString('en-US')}</text>`;
    })
    .join('');

  const name = user.name || user.login;
  return svgShell(
    400,
    240,
    `
    <text x="25" y="40" class="title">${escapeXml(name)}'s GitHub Stats</text>
    <line x1="25" y1="50" x2="375" y2="50" stroke="${THEME.accentSoft}" stroke-width="1" />
    ${items}
  `,
  );
}

function langsSvg(langs) {
  const top = langs.slice(0, 6);
  const sumPct = top.reduce((s, l) => s + l.pct, 0) || 1;
  const barW = 350;
  const barX = 25;
  const barY = 60;

  let cursor = barX;
  const segments = top
    .map((l) => {
      const w = (l.pct / sumPct) * barW;
      const seg = `<rect x="${cursor.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="10" fill="${l.color}" />`;
      cursor += w;
      return seg;
    })
    .join('');

  const legend = top
    .map((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const lx = 25 + col * 175;
      const ly = 105 + row * 28;
      return `
    <circle cx="${lx + 6}" cy="${ly - 4}" r="6" fill="${l.color}" />
    <text x="${lx + 20}" y="${ly}" class="label">${escapeXml(l.name)}</text>
    <text x="${lx + 165}" y="${ly}" class="muted" text-anchor="end">${l.pct.toFixed(1)}%</text>`;
    })
    .join('');

  return svgShell(
    400,
    240,
    `
    <text x="25" y="40" class="title">Most Used Languages</text>
    <line x1="25" y1="50" x2="375" y2="50" stroke="${THEME.accentSoft}" stroke-width="1" />
    <clipPath id="barClip"><rect x="${barX}" y="${barY}" width="${barW}" height="10" rx="5" /></clipPath>
    <g clip-path="url(#barClip)">${segments}</g>
    ${legend}
  `,
  );
}

function streakSvg(user, streaks) {
  const totalContribs = user.contributionsCollection.contributionCalendar.totalContributions;
  const days = flattenDays(user.contributionsCollection.contributionCalendar.weeks);
  const firstDate = days[0]?.date || '';
  const lastDate = days[days.length - 1]?.date || '';

  const col = (cx, big, label, sub) => `
    <text x="${cx}" y="95" class="big" text-anchor="middle">${big}</text>
    <text x="${cx}" y="125" class="label" text-anchor="middle">${label}</text>
    <text x="${cx}" y="145" class="muted" text-anchor="middle">${sub}</text>`;

  const fmt = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
  };

  return svgShell(
    500,
    195,
    `
    <text x="250" y="35" class="title" text-anchor="middle">Contribution Activity</text>
    <line x1="25" y1="48" x2="475" y2="48" stroke="${THEME.accentSoft}" stroke-width="1" />
    ${col(85, totalContribs.toLocaleString('en-US'), 'Total Contributions', `${fmt(firstDate)} – ${fmt(lastDate)}`)}
    <line x1="166" y1="65" x2="166" y2="160" stroke="${THEME.muted}" stroke-width="1" opacity="0.3" />
    <circle cx="250" cy="80" r="22" fill="none" stroke="${THEME.fire}" stroke-width="2" />
    <text x="250" y="95" class="big" text-anchor="middle" fill="${THEME.fire}">${streaks.current}</text>
    <text x="250" y="125" class="label" text-anchor="middle">Current Streak</text>
    <text x="250" y="145" class="muted" text-anchor="middle">${streaks.current > 0 ? fmt(streaks.currentStart) + ' – Today' : 'No active streak'}</text>
    <line x1="334" y1="65" x2="334" y2="160" stroke="${THEME.muted}" stroke-width="1" opacity="0.3" />
    ${col(415, streaks.longest.toLocaleString('en-US'), 'Longest Streak', streaks.longest > 0 ? `${fmt(streaks.longestStart)} – ${fmt(streaks.longestEnd)}` : '—')}
  `,
  );
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

// ----- main -----
const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'assets');
mkdirSync(outDir, { recursive: true });

console.log(`Fetching GitHub stats for @${USERNAME}...`);
const user = await fetchUserBasics(USERNAME);
const repos = await fetchAllRepos(USERNAME);
const langs = aggregateLanguages(repos);
const streaks = computeStreaks(user.contributionsCollection.contributionCalendar.weeks);
const lifetimeCommits = await fetchLifetimeCommits(USERNAME, user.createdAt);

console.log(
  `repos=${repos.length} langs=${langs.length} current=${streaks.current} longest=${streaks.longest} commits=${lifetimeCommits}`,
);

writeFileSync(resolve(outDir, 'stats.svg'), statsSvg(user, repos, lifetimeCommits));
writeFileSync(resolve(outDir, 'top-langs.svg'), langsSvg(langs));
writeFileSync(resolve(outDir, 'streak.svg'), streakSvg(user, streaks));

console.log('Wrote assets/stats.svg, assets/top-langs.svg, assets/streak.svg');
