/**
 * 本地 mock 搜索后端 —— 仅用于演示 VIGIL_SEARCH_URL 契约。
 *
 * 契约（与 src/loop/evidenceProvider.ts 的 HttpSearchSource 对齐）：
 *   接收  POST { query, dimension }
 *   返回  { answer }   （也兼容 { snippet }）
 *
 * 真实部署时，把它换成你自己的搜索代理 / 向量库 / 爬虫 / LLM 工具端点即可，
 * 只要满足同样的请求/响应形状，vigil 就能自动把政策/专家/风险/替代/合规维度补抓为已核验证据。
 */
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);

// 模拟证据库：领域关键词 -> 维度 -> 文本（标注 (mock) 以示这是演示数据，非真实来源）
const KB = {
  fd: {
    authoritative:
      '(mock) 中国食品土畜进出口商会年报：东南亚冻干水果/小吃需求稳定，RCEP 关税减让利好；欧美冻干咖啡/零食客单价高但合规门槛高。',
    regulatory:
      '(mock) 出口食品生产企业需备案；东南亚接受中国检验检疫证书；欧美需 FDA 注册/HACCP/EFSA 标签合规，单证不全即退运。',
    expert:
      '(mock) 东南亚贸易商：订单小、账期长、门槛低、试错快；欧美卖家：利润厚但合规与广告是生死线，新手易封号。',
    risk:
      '(mock) 红牌：欧美合规单证缺失即退运、平台封号、现金占用大易断链；东南亚账期长致现金流紧张，但无硬性合规红牌。',
    alternative:
      '(mock) 可转国内冻干 ODM 代工兜底；可用 TikTok Shop/独立站分流降平台依赖。',
  },
  edu: {
    authoritative:
      '(mock) 湖南省专升本为全省统考入学，面向应届高职毕业生；获省级以上技能大赛一等奖可免试入读本科（以当年政策为准）。',
    regulatory:
      '(mock) 统招专升本录取后编入本科三年级，发全日制本科证，第一学历为本科；免试名额有限、专业对口严、政策逐年调整。',
    expert:
      '(mock) 招生老师：专升本路线稳定、可准备周期长，适合基础中等但肯学者；竞赛老师：需从大一持续备赛，淘汰率高。',
    risk:
      '(mock) 红牌：竞赛一等奖获奖率极低、政策逐年收紧，孤注一掷风险大；若大三才发现拿不到奖，已错过统招备考窗口。',
    alternative:
      '(mock) 若统招专升本失利可自考本科兜底；若竞赛未获奖可凭大专+实习直接就业。',
  },
};

function pickKB(query) {
  if (/冻干|FD|跨境/.test(query)) return KB.fd;
  if (/专升本|竞赛|升学|本科/.test(query)) return KB.edu;
  return KB.fd; // 默认走冻干库，避免演示空回答
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/query') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad json' }));
      return;
    }
    const dim = data.dimension ?? 'authoritative';
    const kb = pickKB(data.query ?? '');
    const answer = kb[dim] ?? `(mock) 暂无「${dim}」维度可用摘要。`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answer }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[mock-search] listening on http://localhost:${PORT}/query  (POST {query, dimension} -> {answer})`);
});
