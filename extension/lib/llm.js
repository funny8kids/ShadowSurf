/**
 * ShadowSurf · LLM 客户端
 *
 * 只依赖 OpenAI 兼容协议（POST /chat/completions），因此可以接：
 * OpenAI / DeepSeek / 通义千问 / Kimi / 智谱 / 硅基流动 / Ollama / LM Studio
 * 以及任何自建中转。
 *
 * 刻意不引入 SDK：扩展里多一个依赖就多一份打包和权限麻烦，
 * 而兼容协议本身只有一次 fetch 的量级。
 */

/* ------------------------------------------------------------------ */
/* 服务商预设                                                          */
/* ------------------------------------------------------------------ */

export const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '官方接口，需要可用的网络环境'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '国内直连，性价比高，适合做 Agent 决策'
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    hint: '阿里云 DashScope 兼容模式'
  },
  {
    id: 'kimi',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    hint: '长上下文见长，适合读长页面'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    hint: '注意版本段是 /v4 而不是 /v1'
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    hint: '聚合多家开源模型'
  },
  {
    id: 'ollama',
    name: 'Ollama 本地',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    hint: '本地推理，数据不出机器，Key 随便填'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    hint: '本地服务，需在 LM Studio 里开启 Server'
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: '',
    model: '',
    hint: '任何兼容 /chat/completions 的地址'
  }
];

export const DEFAULT_SETTINGS = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
  maxSteps: 12,
  autoRun: true
};

/* ------------------------------------------------------------------ */
/* 地址解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把用户填的 Base URL 补全成完整的 chat/completions 端点。
 * 用户可能填 https://api.deepseek.com，也可能填到 /v1，
 * 也可能直接贴了完整端点 —— 三种都要能work。
 */
export function resolveEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('还没有填写 Base URL');

  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

  if (/\/chat\/completions$/i.test(u)) return u;

  // 已经带版本段（/v1 /v4 /compatible-mode/v1 …）就直接拼
  if (/\/v\d+[a-z0-9]*$/i.test(u)) return u + '/chat/completions';

  return u + '/v1/chat/completions';
}

/* ------------------------------------------------------------------ */
/* JSON 容错解析                                                       */
/* ------------------------------------------------------------------ */

/** 模型经常在 JSON 外面裹一层 ``` 或说明文字，这里做剥离 */
export function parseJSONLoose(text) {
  if (typeof text !== 'string') throw new Error('模型返回内容为空');

  let s = text.trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);

  try {
    return JSON.parse(s);
  } catch {
    const preview = text.slice(0, 160).replace(/\n/g, ' ');
    throw new Error(`模型没有返回合法 JSON：${preview}…`);
  }
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

function friendlyError(status, bodyText, endpoint) {
  const brief = (bodyText || '').slice(0, 240);

  if (status === 401 || status === 403) {
    return new Error('API Key 无效或没有权限（401/403）。请检查 Key 是否填错、是否过期。');
  }
  if (status === 404) {
    return new Error(
      `接口不存在（404）。请检查 Base URL，当前实际请求：${endpoint}`
    );
  }
  if (status === 429) {
    return new Error('触发限流（429）。稍等几秒再试，或换一个模型。');
  }
  if (status >= 500) {
    return new Error(`模型服务端错误（${status}）。${brief}`);
  }
  return new Error(`请求失败（${status}）。${brief}`);
}

/**
 * 发一次对话请求。
 * @returns {Promise<{text: string, usage?: object, endpoint: string}>}
 */
export async function chat({
  settings,
  messages,
  jsonMode = false,
  temperature,
  timeoutMs = 90000,
  signal
}) {
  if (!settings || !settings.model) throw new Error('还没有选择模型');

  const endpoint = resolveEndpoint(settings.baseUrl);
  const key = String(settings.apiKey || '').trim();

  // 本地服务通常不校验 Key，但有些实现要求非空
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(endpoint);
  if (!key && !isLocal) throw new Error('还没有填写 API Key');

  const body = {
    model: settings.model,
    messages,
    temperature: temperature ?? settings.temperature ?? 0.2,
    stream: false
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const run = async (payload) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {})
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = friendlyError(res.status, text, endpoint);
        err.status = res.status;
        err.bodyText = text;
        throw err;
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? '';
      if (!text) throw new Error('模型返回了空内容');
      return { text, usage: data.usage, endpoint };
    } catch (e) {
      if (e.name === 'AbortError') {
        if (signal && signal.aborted) throw new Error('已停止');
        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）。模型或网络可能较慢。`);
      }
      if (e instanceof TypeError) {
        throw new Error(
          `无法连接到 ${endpoint}。检查 Base URL 是否正确、服务是否启动、或是否需要代理。`
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };

  try {
    return await run(body);
  } catch (e) {
    // 部分兼容端点不支持 response_format，去掉后重试一次
    const unsupported =
      e.status === 400 &&
      /response_format|json_object|unsupported|invalid.*param/i.test(e.bodyText || '');
    if (jsonMode && unsupported) {
      const { response_format, ...rest } = body;
      return await run(rest);
    }
    throw e;
  }
}

/** 连通性测试：发一句最短的话，验证 Key / 地址 / 模型三件事 */
export async function testConnection(settings) {
  const started = Date.now();
  const { text, endpoint } = await chat({
    settings,
    messages: [{ role: 'user', content: '只回复 ok' }],
    temperature: 0,
    timeoutMs: 25000
  });
  return {
    ok: true,
    endpoint,
    latency: Date.now() - started,
    reply: text.slice(0, 40)
  };
}
