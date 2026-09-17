import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'obsidian';
import { LlmClient } from '../src/llm/client';

test('AI blocks unsafe endpoints, cancellation sends nothing, and a changed endpoint needs consent', async () => {
 const oldWindow = globalThis.window;
 const oldFetch = globalThis.fetch;
 let prompts = 0, requests = 0, allow = false;
 let baseUrl = 'http://example.com/v1';
 globalThis.window = { confirm: () => { prompts++; return allow; }, setTimeout, clearTimeout } as any;
 globalThis.fetch = (async (_url, options) => {
  requests++;
  assert.equal(options?.redirect, 'error');
  return new Response('{"choices":[{"message":{"content":"ok"}}]}', {status: 200});
 }) as typeof fetch;
 const client = new LlmClient(new App(), () => ({baseUrl, apiKey:'test-only', model:'test'}));
 const send = async () => { for await (const _ of client.streamChat([])) {} };
 try {
  for (baseUrl of ['http://example.com/v1', 'http://localhost.evil/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=secret', 'not a url']) {
   await assert.rejects(send);
   assert.equal((await client.testConnection()).ok, false);
  }
  assert.equal(prompts, 0); assert.equal(requests, 0);
  baseUrl = 'https://example.com/v1';
  await assert.rejects(send, /已取消/);
  assert.equal(requests, 0);
  allow = true;
  await send(); await send();
  assert.equal(prompts, 2); assert.equal(requests, 2);
  baseUrl = 'https://other.example/v1'; await send();
  assert.equal(prompts, 3);
  for (baseUrl of ['http://localhost:1234/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1']) await send();
  assert.equal(requests, 6);
 } finally { globalThis.window = oldWindow; globalThis.fetch = oldFetch; }
});
