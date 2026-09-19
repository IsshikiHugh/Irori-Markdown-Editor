// Assemble latest.json — the file installed copies of Irori read to find the newest release —
// from the draft release's signed updater bundles, and attach it to the release.
//
// Run by the release workflow's `publish` job once every platform has uploaded, so the file is
// written once and whole, instead of being merged by four builds racing each other. A bundle or
// signature that is missing fails the job, and the release stays a draft.
//
// env: GITHUB_REPOSITORY, GH_TOKEN, RELEASE_ID, RELEASE_TAG

const { GITHUB_REPOSITORY: repo, GH_TOKEN: token, RELEASE_ID: id, RELEASE_TAG: tag } = process.env;
if (!repo || !token || !id || !tag) throw new Error('GITHUB_REPOSITORY, GH_TOKEN, RELEASE_ID and RELEASE_TAG are required');

const auth = { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
async function api(url, init = {}) {
  const res = await fetch(url.startsWith('https:') ? url : `https://api.github.com/repos/${repo}/${url}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', ...auth, ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url}: ${res.status} ${await res.text()}`);
  return res;
}

// Which bundle each updater target installs. An installed copy looks for
// `{os}-{arch}-{installer}` first, then plain `{os}-{arch}`.
const TARGETS = [
  [/_aarch64\.app\.tar\.gz$/, ['darwin-aarch64-app', 'darwin-aarch64']],
  [/_x64\.app\.tar\.gz$/, ['darwin-x86_64-app', 'darwin-x86_64']],
  [/_amd64\.AppImage$/, ['linux-x86_64-appimage', 'linux-x86_64']],
  [/_amd64\.deb$/, ['linux-x86_64-deb']],
  [/\.x86_64\.rpm$/, ['linux-x86_64-rpm']],
  [/_x64-setup\.exe$/, ['windows-x86_64-nsis', 'windows-x86_64']],
  [/_x64_en-US\.msi$/, ['windows-x86_64-msi']],
];

const release = await (await api(`releases/${id}`)).json();
const byName = new Map(release.assets.map((a) => [a.name, a]));

const platforms = {};
const missing = [];
for (const [pattern, targets] of TARGETS) {
  const bundle = release.assets.find((a) => pattern.test(a.name));
  const sig = bundle && byName.get(bundle.name + '.sig');
  if (!sig) {
    missing.push(bundle ? bundle.name + '.sig' : String(pattern));
    continue;
  }
  const signature = await (await api(`releases/assets/${sig.id}`, { headers: { accept: 'application/octet-stream' } })).text();
  const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(bundle.name)}`;
  for (const target of targets) platforms[target] = { signature: signature.trim(), url };
}
if (missing.length) throw new Error('missing from the release: ' + missing.join(', '));

const manifest = {
  version: tag.replace(/^v/, ''),
  notes: release.body ?? '',
  pub_date: new Date().toISOString(),
  platforms,
};
console.log(JSON.stringify({ ...manifest, platforms: Object.keys(platforms) }, null, 2));

// a re-run replaces the file instead of failing on the name being taken
const old = byName.get('latest.json');
if (old) await api(`releases/assets/${old.id}`, { method: 'DELETE' });
await api(`https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=latest.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(manifest, null, 2),
});
