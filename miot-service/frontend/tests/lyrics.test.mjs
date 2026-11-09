import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { computed, ref } from 'vue';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const requests = [], watches = [];
  let unmount;
  const state = { player: { current_song: { id: 1 }, position: 0 }, config: {} };
  const env = {
    state, computed, ref, useSongCover: () => ({ src: ref(''), epoch: ref(0) }),
    navigation: { playerPage: 1, page: 'player' },
    get: path => { const request = deferred(); requests.push({ path, ...request }); return request.promise; },
    watch: (source, callback) => watches.push(callback), onMounted() {},
    onUnmounted: fn => { unmount = fn; }, window: { clearTimeout() {} },
  };
  const source = readFileSync(new URL('../src/views/FullscreenPlayer.vue', import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
  const js = ts.transpileModule(source + '\nreturn { loadSongDetails, retryLyrics, lyrics, lyricLoading, lyricError, isFavorite };', {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const page = new Function(...Object.keys(env), js)(...Object.values(env));
  const complete = (index, text) => {
    requests[index].resolve({ lyric: `[00:01]${text}` });
    requests[index + 1].resolve({ is_favorited: true });
  };
  return { ...page, state, requests, watches, complete, unmount: () => unmount() };
}

test('switching song clears old lyrics immediately and ignores a late result', async () => {
  const h = fixture();
  const first = h.loadSongDetails();
  h.state.player.current_song = { id: 2 };
  const second = h.loadSongDetails();
  h.complete(2, 'second');
  await second;
  assert.equal(h.lyrics.value[0].text, 'second');
  h.complete(0, 'first');
  await first;
  assert.equal(h.lyrics.value[0].text, 'second');
  h.state.player.current_song = { id: 3 };
  const third = h.loadSongDetails();
  assert.deepEqual(h.lyrics.value, []);
  h.complete(4, 'third');
  await third;
});

test('stopping or unmounting while searching discards pending lyrics and favorite status', async () => {
  for (const action of ['stop', 'unmount']) {
    const h = fixture();
    const pending = h.loadSongDetails();
    if (action === 'stop') {
      h.state.player.current_song = undefined;
      await h.loadSongDetails();
    } else h.unmount();
    h.complete(0, 'stale');
    await pending;
    assert.deepEqual(h.lyrics.value, []);
    assert.equal(h.isFavorite.value, false);
  }
});

test('lyrics render before favorite status finishes, and a retry cannot erase that status', async () => {
  const h = fixture();
  const pending = h.loadSongDetails();
  assert.equal(h.lyricLoading.value, true);
  h.requests[0].resolve({ lyric: '' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(h.lyricLoading.value, false);
  assert.equal(h.lyricError.value, '');
  const retry = h.retryLyrics();
  assert.equal(h.requests[2].path, '/lyric?song_id=1&refresh=1');
  await h.retryLyrics();
  assert.equal(h.requests.length, 3); // double click does not issue another request
  h.requests[2].resolve({ lyric: '[00:01]retried' });
  await retry;
  assert.equal(h.lyrics.value[0].text, 'retried');
  h.requests[1].resolve({ is_favorited: true });
  await pending;
  assert.equal(h.isFavorite.value, true);
});

test('request failure has a distinct message and successful retry clears it', async () => {
  const h = fixture();
  const pending = h.loadSongDetails();
  h.requests[0].reject(new Error('upstream timeout'));
  h.requests[1].reject(new Error('favorite unavailable'));
  await pending;
  assert.equal(h.lyricLoading.value, false);
  assert.match(h.lyricError.value, /获取失败/);
  const retry = h.retryLyrics();
  assert.equal(h.lyricError.value, '');
  h.requests[2].resolve({ lyric: '[00:02]recovered' });
  await retry;
  assert.equal(h.lyrics.value[0].text, 'recovered');
});
