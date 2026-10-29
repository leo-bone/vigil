/**
 * 演示：配置 VIGIL_SEARCH_URL 后，政策/专家/风险/替代/合规维度如何被真实后端自动补抓。
 *
 * 本脚本把"mock 搜索后端"和"决策循环"放进同一进程（loopback 已在沙箱验证可达），
 * 真实走过的契约与 CLI 的 `VIGIL_SEARCH_URL=... vigil loop <goal> --gather` 完全一致：
 *   buildSources({ searchUrl }) → HttpSearchSource → POST {query,dimension} → {answer}
 *
 * 真机部署时，只需把 mock server 换成你自己的搜索代理 / 向量库 / 爬虫 / LLM 工具端点。
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { DecisionLoop } from '../src/loop/decisionLoop.ts';
import { buildSources, gatherEvidence } from '../src/loop/evidenceProvider.ts';
import { resolveDomainSpec } from '../src/loop/evidence.ts';
import { Kernel } from '../src/kernel.ts';
import { MockJudge } from '../src/judge/mock.ts';
import { Ledger } from '../src/ledger/store.ts';

// 按方案(option)分：后端拿到 option 后返回方案专属证据，多方案矩阵才能精确评分
const KB_OPTION: Record<string, Record<string, string>> = {
  'B2B批发-东南亚': {
    authoritative:
      '(mock) 东南亚（越南/泰国/马来）华人渠道对冻干水果、冻干小吃需求稳定；RCEP 关税减让利好；2025 中国冻干食品出口同比约 +18%。',
    regulatory:
      '(mock) 东南亚多数国家接受中国检验检疫证书，出口食品生产企业备案即可，无欧美式退运红牌，合规成本低。',
    expert:
      '(mock) 长沙本地东南亚食品出口贸易商：订单小、议价狠、账期长，但门槛低、试错快，适合先跑通供应链再扩品类。',
    risk:
      '(mock) 风险：账期长致现金流紧张、汇率波动（USD/CNY≈6.67）、低价内卷；但无硬性合规红牌，试错成本低。',
    alternative:
      '(mock) 若跨境受挫，可转而服务国内新消费品牌做冻干 ODM 代工，利用同一产线去化产能。',
  },
  '跨境电商零售-欧美': {
    authoritative:
      '(mock) 欧美冻干食品（冻干咖啡、冻干零食、户外食品）客单价高、复购强，市场空间大。',
    regulatory:
      '(mock) 红牌：欧美准入需 FDA 注册（美）、EU 食品接触材料与标签合规（欧）、HACCP；单证不全直接被退运，前期合规成本 5-15 万。',
    expert:
      '(mock) 跨境电商冻干品类卖家：欧美利润厚但合规与广告是生死线，新手易被封号/退运；建议先小批量测款再重投。',
    risk:
      '(mock) 红牌：合规单证缺失即退运、平台封号、广告 ROI 不稳；资金占用大，一旦滞销现金链断裂风险高。',
    alternative:
      '(mock) 除亚马逊外，可用 TikTok Shop、独立站分流，降低单一平台依赖与封号风险。',
  },
  '专升本': {
    authoritative:
      '(mock) 湖南省专升本为全省统考入学，面向应届高职（专科）毕业生，需参加全省统考+院校专业测试。',
    regulatory:
      '(mock) 统招专升本录取后编入本科三年级，毕业发全日制本科证；第一学历为本科。',
    expert:
      '(mock) 招生老师：统招专升本路线稳定、可准备周期长（大三下考试），适合基础中等但肯学的同学。',
    risk:
      '(mock) 风险：需投入备考时间，若落榜则晚半年就业；但路径可逆，可自考兜底，无硬性红牌。',
    alternative:
      '(mock) 若统招专升本失利，可考虑自考本科（非全日制）作为兜底，但含金量低于统招。',
  },
  '竞赛免试升本科': {
    authoritative:
      '(mock) 获省级以上职业院校技能大赛一等奖可免试入读本科（具体院校与专业以当年政策为准）。',
    regulatory:
      '(mock) 免试通道名额有限、专业对口要求严，且政策逐年可能调整，存在不确定性。',
    expert:
      '(mock) 竞赛指导老师：女儿数智营销专业对口「互联网+」/市场营销赛项，但需从大一持续备赛，淘汰率高。',
    risk:
      '(mock) 红牌：竞赛一等奖获奖率极低、政策逐年收紧，孤注一掷风险大；若大三才发现拿不到奖，已错过统招备考窗口。',
    alternative:
      '(mock) 若竞赛未获奖，可凭大专学历+实习直接就业，数智营销岗位需求尚可。',
  },
};
// 单方案 / 未带 option 时的领域通用兜底
const KB_DOMAIN: Record<string, Record<string, string>> = {
  fd: {
    authoritative: '(mock) 冻干食品跨境：东南亚需求稳定、RCEP 利好；欧美客单价高但合规门槛高。',
    regulatory: '(mock) 出口需备案；欧美需 FDA/HACCP，单证不全即退运。',
    expert: '(mock) 东南亚门槛低试错快；欧美利润厚但合规广告是生死线。',
    risk: '(mock) 欧美合规单证缺失即退运、封号、现金链断裂风险高；东南亚账期长但无硬性红牌。',
    alternative: '(mock) 可转国内 ODM 代工兜底；可用 TikTok Shop 分流。',
  },
  edu: {
    authoritative: '(mock) 专升本全省统考入学；省级以上技能大赛一等奖可免试入读本科。',
    regulatory: '(mock) 统招专升本发全日制本科证；免试名额有限、政策逐年调整。',
    expert: '(mock) 专升本路线稳定；竞赛需从大一持续备赛、淘汰率高。',
    risk: '(mock) 竞赛一等奖获奖率极低、政策收紧，孤注一掷风险大。',
    alternative: '(mock) 专升本失利可自考兜底；竞赛未获奖可凭大专就业。',
  },
};
function domainOf(q: string): string {
  return /冻干|FD|跨境/.test(q) ? 'fd' : 'edu';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/query') {
    let b = '';
    for await (const c of req) b += c;
    let d: { query?: string; dimension?: string };
    try {
      d = JSON.parse(b);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const dim = d.dimension ?? 'authoritative';
    const opt = d.option ?? '';
    const specific = KB_OPTION[opt];
    const kb = specific && specific[dim] ? specific : KB_DOMAIN[domainOf(d.query ?? '')];
    const answer = kb[dim] ?? `(mock) 暂无「${dim}」维度可用摘要。`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answer }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});
await new Promise<void>((r) => server.listen(0, 'localhost', () => r()));
const port = (server.address() as { port: number }).port;
const searchUrl = `http://localhost:${port}/query`;
console.log(`[demo] 本地 mock 搜索后端已启动: ${searchUrl}`);

const sources = buildSources({ searchUrl });
const VIGIL_DIR = '/tmp/vigil-demo';

async function runGoal(file: string): Promise<void> {
  console.log(`\n════════════════════════════════════════════════`);
  console.log(`▶ ${file}`);
  const goal = JSON.parse(readFileSync(file, 'utf8'));
  const domain = goal.domain ?? 'work';
  const spec = resolveDomainSpec(goal.evidenceSpec);
  const g = await gatherEvidence(spec, goal.question, domain, sources, { existing: goal.evidence });
  goal.evidence = g.evidence;
  goal.evidenceSpec = spec; // CLI 同样会把字符串规格解析成对象再交给 run()
  const auto = g.evidence.filter((e) => (e.channel ?? '').startsWith('http-search'));
  console.log(`[自动补抓] 搜索后端补回 ${auto.length} 条证据（政策/专家/风险/替代/合规），手填沿用 ${g.evidence.length - auto.length} 条`);
  console.log(`[维度] 已核验: ${g.gathered.join(', ')} ｜ 未核验: ${g.unverified.length ? g.unverified.join(', ') : '无'}`);

  const kernel = new Kernel({ ledger: new Ledger(`${VIGIL_DIR}/ledger.ndjson`), judge: new MockJudge() });
  const loop = new DecisionLoop(kernel, goal, VIGIL_DIR, undefined, undefined, undefined, sources, false);
  loop.on((ev: { stage: string; message: string }) => {
    if (['evidence_gathered', 'reasoning', 'evidence_complete', 'evidence_gap'].includes(ev.stage)) {
      console.log(`   ${ev.stage === 'evidence_gathered' ? '·' : '▸'} ${ev.message}`);
    }
  });
  const state = await loop.run();
  const b = state.brief as { kind: string; recommendedOption?: string; confidence?: string } | undefined;
  if (b && b.kind === 'matrix') {
    console.log(`[结论] 推荐: ${b.recommendedOption ?? '并列(无推荐)'} ｜ 置信度: ${b.confidence} ｜ 循环状态: ${state.status}`);
  }
}

await runGoal('examples/goal-fd-food-export-auto.json');
await runGoal('examples/goal-edu-daughter-auto.json');
server.close();
console.log('\n[demo] 完成。配置 VIGIL_SEARCH_URL 后，原本需手填的政策/专家/风险等维度会被真实后端自动补为已核验证据，决策矩阵照常产出。');
