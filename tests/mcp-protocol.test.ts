import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { handleMcpRequest, Ledger, createPipelineKernel, MockJudge } from '../src/index.ts';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 起一个真实的 MCP 服务端进程，把几行 JSON-RPC 喂进去，返回回包 */
function talk(lines: string[]): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'src/cli.ts'), 'mcp'], {
      cwd: repoRoot,
      env: { ...process.env, VIGIL_QUIET: '1', VIGIL_LEDGER: ':memory:' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => {
      const replies = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return {};
          }
        });
      if (replies.length === 0) reject(new Error(`没有收到任何回包，stderr：${err.slice(0, 300)}`));
      else resolve(replies);
    });
    child.stdin.write(lines.map((line) => line + '\n').join(''));
    child.stdin.end();
  });
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
});
const INITIALIZED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

test('MCP 协议：未 initialize 就调工具会被明确拒绝', async () => {
  const replies = await talk([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vigil_verify', arguments: {} } }),
  ]);
  assert.ok(replies[0]!.error, '应当返回错误');
  assert.equal((replies[0]!.error as { code: number }).code, -32002);
  assert.ok(String((replies[0]!.error as { message: string }).message).includes('initialize'));
});

test('MCP 协议：完整握手后工具清单正常返回', async () => {
  const replies = await talk([INIT, INITIALIZED, LIST]);
  const list = replies.find((reply) => reply.id === 2) as { result: { tools: unknown[] } };
  assert.equal(list.result.tools.length, 10);
});

test('MCP 协议：通知不产生回包（不会多吐一行 JSON）', async () => {
  const replies = await talk([INIT, INITIALIZED, LIST]);
  // initialize + tools/list 两条请求 → 两条回包，通知不该有回包
  assert.equal(replies.length, 2);
  assert.ok(!replies.some((reply) => reply.id === undefined));
});

test('MCP 标注：每个工具都带授权等级与只读提示', async () => {
  const replies = await talk([INIT, INITIALIZED, LIST]);
  const list = replies.find((reply) => reply.id === 2) as {
    result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> };
  };
  const byName = new Map(list.result.tools.map((tool) => [tool.name, tool.annotations]));

  for (const [name, annotations] of byName) {
    assert.ok(annotations, `${name} 缺少 annotations`);
    assert.ok(annotations.vigilAuthority, `${name} 缺少 vigilAuthority`);
    assert.ok(typeof annotations.readOnlyHint === 'boolean', `${name} 缺少 readOnlyHint`);
  }

  // 只读的工具应当真的是只读
  assert.equal(byName.get('vigil_verify')!.readOnlyHint, true);
  assert.equal(byName.get('vigil_postmortem')!.readOnlyHint, true);
  // 写账本的工具不��是只读
  assert.equal(byName.get('vigil_label')!.readOnlyHint, false);
  assert.equal(byName.get('vigil_decide')!.readOnlyHint, false);
  // 仲裁是最高一级
  assert.equal(byName.get('vigil_arbitrate')!.vigilAuthority, 'L4');
});

test('MCP 工具：标注在单元层同样可用（不依赖进程）', async () => {
  const ledger = new Ledger(':memory:');
  const kernel = createPipelineKernel(ledger, new MockJudge());
  const list = (await handleMcpRequest('tools/list', {}, kernel, {})) as {
    tools: Array<{ name: string; annotations: Record<string, unknown> }>;
  };
  assert.equal(list.tools.length, 10);
  assert.ok(list.tools.every((tool) => tool.annotations?.vigilAuthority));
});
