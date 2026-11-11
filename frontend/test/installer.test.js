import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the release asset is the Jay-I setup, built from a pinned Jay-I', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/installer.yml', import.meta.url), 'utf8');
  for (const [, ref] of workflow.matchAll(/^\s*-?\s*uses:\s*\S+@(\S+)/gm)) {
    assert.match(ref, /^[0-9a-f]{40}$/, `every action is pinned by full SHA, got ${ref}`);
  }
  const pin = workflow.match(/repository: TyxMatty\/Jay-I\s+ref: (\S+)/);
  assert.ok(pin, 'the workflow checks out TyxMatty/Jay-I');
  assert.match(pin[1], /^[0-9a-f]{40}$/);
  assert.match(workflow, /jay-i\/scripts\/build-setup\.ps1/);
  assert.match(workflow, /15 \* 1024 \* 1024/);
  assert.ok(workflow.includes('"v$version" -ne $env:GITHUB_REF_NAME'), 'the tag must equal the app version');
  // Only the setup is uploaded and released: Jay-H and the updater take any asset ending in _x64-setup.exe.
  const upload = workflow.match(/upload-artifact@[\s\S]*?\n\s+path: (\S+)/);
  assert.ok(upload, 'the workflow uploads an artifact');
  assert.doesNotMatch(upload[1], /bundle\/nsis/);
  assert.match(upload[1], /^setup-out\//);
  const files = workflow.match(/^\s*files=\((\S+)\)/m);
  assert.ok(files, 'the draft release lists its files');
  assert.doesNotMatch(files[1], /bundle\/nsis/);
  assert.match(files[1], /^setup-out\//);
  // The updater (the jay-i crate) and the setup come from the same Jay-I commit.
  const cargo = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  const dep = cargo.match(/^jay-i\s*=.*$/m);
  assert.ok(dep, 'Cargo.toml depends on jay-i');
  assert.ok(dep[0].includes(`rev = "${pin[1]}"`), `Cargo.toml jay-i rev must be ${pin[1]}`);
});

test('the NSIS template keeps the flags the Jay-I setup relies on', () => {
  const nsi = readFileSync(new URL('../src-tauri/windows/installer.nsi', import.meta.url), 'utf8');
  for (const flag of [
    '${GetOptions} $CMDLINE "/P" $PassiveMode',
    '"/NS" $NoShortcutMode',
    '"/UPDATE" $UpdateMode',
    '${GetOptions} $CMDLINE "/R" $R0',
  ]) {
    assert.ok(nsi.includes(flag), `installer.nsi must keep ${flag}`);
  }
  // The Jay-I setup runs this installer with /S: a new MessageBox needs a /SD default or must sit
  // outside silent mode, otherwise it waits with no visible owner.
  assert.equal(nsi.match(/MessageBox/g)?.length, 3);
});
