const OpenAI = require('openai');

/**
 * AI Service - 支持多模型配置，可复用于其他项目
 * 配置在 .env 中：AI_PROVIDER, AI_DEFAULT_MODEL, OPENAI_API_KEY, GROK_API_KEY, DEEPSEEK_API_KEY 等
 * 
 * Usage in other projects:
 * const { createAIService } = require('ai-report-analyzer'); // or local path
 * const ai = createAIService({ provider: 'deepseek', systemPrompt: '...' });
 */
function trimEnv(name) {
  const v = process.env[name];
  if (v == null) return '';
  return String(v).trim();
}

const DEFAULT_SYSTEM_PROMPT = '你是一个专业的生产制造和报工系统AI分析师。提供准确、实用、数据驱动的洞察和行动建议；正文说明使用中文，但最终回复必须是合法 json 对象（不要 markdown 代码块）。';

class AIService {
  /**
   * Create reusable AI service. Options allow customization for different projects/domains.
   * @param {Object} options - Configuration overrides
   * @param {string} options.provider - 'openai' | 'grok' | 'deepseek'
   * @param {string} options.defaultModel
   * @param {number} options.temperature
   * @param {number} options.maxTokens
   * @param {number} options.timeout
   * @param {string} options.systemPrompt - Override default system prompt
   * @param {string|Function} options.defaultPromptTemplate - Custom template or function
   * @param {Function} options.buildContext - Custom function to turn data into prompt context (data, params) => string
   */
  constructor(options = {}) {
    this.options = { ...options };
    this.provider = (options.provider || trimEnv('AI_PROVIDER') || 'openai').toLowerCase();
    this.defaultModel = options.defaultModel || process.env.AI_DEFAULT_MODEL || 'gpt-4o-mini';
    this.temperature = parseFloat(options.temperature ?? process.env.AI_TEMPERATURE) || 0.1;
    this.maxTokens = parseInt(options.maxTokens ?? process.env.AI_MAX_TOKENS) || 6000;
    this.timeout = parseInt(options.timeout ?? process.env.AI_TIMEOUT_MS) || 45000;
    this.systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.defaultPromptTemplate = options.defaultPromptTemplate || null;
    this.buildContextFn = typeof options.buildContext === 'function' ? options.buildContext : null;

    this.client = this.createClient();
  }

  /** 与 createClient 使用同一套规则，用于调用前校验 */
  getConfiguredApiKey() {
    if (this.provider === 'openai' || this.provider === 'grok') {
      if (this.provider === 'grok') {
        return trimEnv('GROK_API_KEY') || trimEnv('OPENAI_API_KEY');
      }
      return trimEnv('OPENAI_API_KEY');
    }
    if (this.provider === 'deepseek') {
      return trimEnv('DEEPSEEK_API_KEY') || trimEnv('OPENAI_API_KEY');
    }
    return trimEnv('OPENAI_API_KEY');
  }

  expectedKeyHint() {
    if (this.provider === 'grok') return 'GROK_API_KEY（或兼容填写 OPENAI_API_KEY）';
    if (this.provider === 'deepseek') return 'DEEPSEEK_API_KEY（或兼容填写 OPENAI_API_KEY）';
    return 'OPENAI_API_KEY';
  }

  createClient() {
    if (this.provider === 'openai' || this.provider === 'grok') {
      const apiKey = this.provider === 'grok' 
        ? (trimEnv('GROK_API_KEY') || trimEnv('OPENAI_API_KEY'))
        : trimEnv('OPENAI_API_KEY');

      if (!apiKey) {
        console.warn('[AI] Warning: No API key configured for', this.provider);
      }

      const baseURL = this.provider === 'grok' 
        ? 'https://api.x.ai/v1' 
        : undefined;

      return new OpenAI({
        apiKey: apiKey || 'dummy-key-for-dev',
        baseURL,
        timeout: this.timeout,
      });
    }

    // DeepSeek：OpenAI 兼容接口，见 https://api-docs.deepseek.com/zh-cn/
    if (this.provider === 'deepseek') {
      const apiKey = trimEnv('DEEPSEEK_API_KEY') || trimEnv('OPENAI_API_KEY');
      if (!apiKey) {
        console.warn('[AI] Warning: No DEEPSEEK_API_KEY (或 OPENAI_API_KEY) configured for deepseek');
      }
      const baseURL = trimEnv('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com';
      return new OpenAI({
        apiKey: apiKey || 'dummy-key-for-dev',
        baseURL,
        timeout: this.timeout,
      });
    }
    
    // For other providers (anthropic, ollama), extend here
    console.warn(`[AI] Provider ${this.provider} not fully implemented, falling back to OpenAI`);
    return new OpenAI({
      apiKey: trimEnv('OPENAI_API_KEY') || 'dummy-key-for-dev',
      timeout: this.timeout,
    });
  }

  /**
   * Generate AI analysis for a report
   * @param {string} prompt - Full prompt including menu ai_prompt + data
   * @param {object} options - Additional options
   */
  async generateAnalysis(prompt, options = {}) {
    const model = options.model || this.defaultModel;

    const configuredKey = this.getConfiguredApiKey();
    if (!configuredKey) {
      const hint = this.expectedKeyHint();
      const msg = `未检测到 ${hint}。请写入 server/.env 或仓库根目录 .env 后重启服务（当前 AI_PROVIDER=${this.provider}）。`;
      console.warn('[AI]', msg);
      return {
        success: false,
        error: 'MISSING_API_KEY',
        provider: this.provider,
        fallback: msg,
      };
    }

    try {
      console.log(`[AI] Generating analysis with ${this.provider}/${model}...`);

      const completion = await this.client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: this.systemPrompt,
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        response_format: { type: 'json_object' }  // Force structured JSON output - key to reliability
      });

      const content = completion.choices[0].message.content;
      let result;

      try {
        result = JSON.parse(content);
      } catch (e) {
        // If not valid JSON, try to extract
        result = {
          overview: content.substring(0, 200),
          insights: ['分析结果解析失败，请检查Prompt'],
          recommendations: [],
          raw: content
        };
      }

      return {
        success: true,
        provider: this.provider,
        model,
        result,
        formatted: this.formatResultForDisplay(result),
        usage: completion.usage
      };
    } catch (error) {
      console.error('[AI] Error generating analysis:', error.message);
      const status = error && error.status;
      const code = error && error.code;
      let fallback =
        'AI 服务暂时不可用，请稍后重试。若刚配置过 Key，请确认变量名与 AI_PROVIDER 一致并重启服务。';
      if (status === 401 || code === 'invalid_api_key') {
        fallback = `API 鉴权失败（401）：请检查 ${this.expectedKeyHint()} 是否正确、是否有多余空格或已失效。`;
      } else if (status === 429) {
        fallback = 'AI 请求过于频繁或额度不足（429），请稍后再试或检查账户配额。';
      }
      return {
        success: false,
        error: error.message,
        provider: this.provider,
        fallback,
      };
    }
  }

  /**
   * General assistant chat (plain text). Does not use response_format json mode.
   * @param {Array<{role: string, content: string}>} messages - full messages including system as first entry
   * @param {object} options
   */
  async generateChat(messages, options = {}) {
    const model = options.model || this.defaultModel;
    const configuredKey = this.getConfiguredApiKey();
    if (!configuredKey) {
      const hint = this.expectedKeyHint();
      const msg = `未检测到 ${hint}。请写入 server/.env 或仓库根目录 .env 后重启服务（当前 AI_PROVIDER=${this.provider}）。`;
      console.warn('[AI]', msg);
      return {
        success: false,
        error: 'MISSING_API_KEY',
        provider: this.provider,
        fallback: msg,
      };
    }

    if (!Array.isArray(messages) || messages.length < 2) {
      return {
        success: false,
        error: 'INVALID_MESSAGES',
        provider: this.provider,
        fallback: '对话内容无效',
      };
    }

    try {
      console.log(`[AI] Chat completion ${this.provider}/${model} (${messages.length} msgs)...`);

      const completion = await this.client.chat.completions.create({
        model,
        messages,
        temperature: options.temperature != null ? options.temperature : Math.min(0.6, this.temperature + 0.25),
        max_tokens: options.maxTokens ?? 2048,
      });

      const choice = completion.choices && completion.choices[0];
      const content = AIService.extractChatTextContent(choice && choice.message).trim();

      if (!content) {
        return {
          success: false,
          error: 'EMPTY_RESPONSE',
          provider: this.provider,
          fallback: 'AI 未返回有效内容，请重试',
        };
      }

      return {
        success: true,
        provider: this.provider,
        model,
        content,
        usage: completion.usage,
      };
    } catch (error) {
      console.error('[AI] Chat error:', error.message);
      const status = error && error.status;
      const code = error && error.code;
      let fallback =
        'AI 服务暂时不可用，请稍后重试。若刚配置过 Key，请确认变量名与 AI_PROVIDER 一致并重启服务。';
      if (status === 401 || code === 'invalid_api_key') {
        fallback = `API 鉴权失败（401）：请检查 ${this.expectedKeyHint()} 是否正确。`;
      } else if (status === 429) {
        fallback = '请求过于频繁或额度不足（429），请稍后再试。';
      }
      return {
        success: false,
        error: error.message,
        provider: this.provider,
        fallback,
      };
    }
  }

  /**
   * Build prompt from config and report data. Made generic for reuse in other projects.
   * Supports custom buildContextFn passed in constructor for different data shapes.
   * @param {Object} config - { label, ai_prompt?, ... }
   * @param {Object} reportData - Data with rows, columns, etc. (or any shape if custom buildContext)
   * @param {Object} params - Filter parameters
   */
  buildPrompt(config = {}, reportData = {}, params = {}) {
    const basePrompt = config.ai_prompt || this.getDefaultPrompt(config.label || '报表');
    
    let metrics, sample, contextStr;
    
    if (this.buildContextFn) {
      // Allow custom context building for different data structures/domains
      contextStr = this.buildContextFn(reportData, params);
    } else {
      metrics = this.generateMetrics(reportData);
      sample = this.generateDataSample(reportData.rows || reportData.data || [], 5);
      contextStr = `
**关键统计指标**：
${metrics}

**数据样本（前5行）**：
${sample}

**列信息**：${(reportData.columns || reportData.headers || []).join(', ')}
`;
    }
    
    let prompt = basePrompt
      .replace('{report_label}', config.label || '未命名报表')
      .replace('{filters}', JSON.stringify(params || {}, null, 2))
      .replace('{metrics}', metrics || '使用自定义上下文')
      .replace('{data_sample}', sample || '使用自定义上下文')
      .replace('{columns}', (reportData.columns || reportData.headers || []).join(', '))
      .replace('{context}', contextStr || '');

    return prompt;
  }

  formatResultForDisplay(result) {
    if (!result || typeof result !== 'object') return String(result || '');

    let lines = [];

    // Handle multiple possible keys for each section (model sometimes deviates from schema)
    const overview = result.overview || result.risk_conclusion || result.conclusion || result.summary || result.report_type;
    if (overview) {
      lines.push('📋 概览');
      lines.push(overview);
      lines.push('');
    }

    // Key metrics - support both array of objects and flat fields
    if (result.keyMetrics && Array.isArray(result.keyMetrics) && result.keyMetrics.length > 0) {
      lines.push('📊 关键指标');
      result.keyMetrics.forEach(m => {
        const change = m.change ? ` ${m.change}` : '';
        lines.push(`  • ${m.label || '指标'}: ${m.value}${change}`);
      });
      lines.push('');
    } else if (result.total_entries !== undefined || result.overdue_rate) {
      lines.push('📊 关键指标');
      if (result.total_entries !== undefined) lines.push(`  • 总条目: ${result.total_entries}`);
      if (result.overdue_entries !== undefined) lines.push(`  • 超期条目: ${result.overdue_entries}`);
      if (result.overdue_rate) lines.push(`  • 超期率: ${result.overdue_rate}`);
      if (result.normal_rate) lines.push(`  • 正常率: ${result.normal_rate}`);
      lines.push('');
    }

    const insights = result.insights || result.key_points || result.main_points;
    if (insights) {
      lines.push('💡 主要洞察');
      if (Array.isArray(insights)) {
        insights.forEach(item => lines.push('  • ' + item));
      } else if (typeof insights === 'string') {
        lines.push('  • ' + insights);
      }
      lines.push('');
    }

    const anomalies = result.anomalies || result.risks;
    if (anomalies) {
      lines.push('⚠️ 异常/风险');
      if (Array.isArray(anomalies)) {
        anomalies.forEach(item => lines.push('  • ' + item));
      } else if (typeof anomalies === 'string') {
        lines.push('  • ' + anomalies);
      }
      lines.push('');
    }

    const recommendations = result.recommendations || result.suggestions || result.actions;
    if (recommendations) {
      lines.push('🎯 行动建议');
      if (Array.isArray(recommendations)) {
        recommendations.forEach(item => lines.push('  • ' + item));
      } else if (typeof recommendations === 'string') {
        lines.push('  • ' + recommendations);
      }
      lines.push('');
    }

    if (result.suggestedHighlights && Array.isArray(result.suggestedHighlights) && result.suggestedHighlights.length > 0) {
      lines.push('🔍 建议重点关注');
      result.suggestedHighlights.forEach(item => lines.push('  • ' + item));
      lines.push('');
    }

    // If we got meaningful content, return it. Otherwise fall back to pretty JSON
    const formatted = lines.join('\n').trim();
    if (formatted && formatted.length > 20) {
      return formatted;
    }

    // Pretty print JSON with better formatting for when model completely deviates
    try {
      return '📋 AI 分析结果\n\n' + JSON.stringify(result, null, 2);
    } catch (e) {
      return String(result);
    }
  }

  getDefaultPrompt(reportLabel) {
    // Default template is battle-tested. Can be overridden via constructor options.defaultPromptTemplate
    // or by passing ai_prompt in config. The {context} placeholder allows flexible data injection.
    return `你是专业的${reportLabel || '业务'}数据分析师。

报表名称：${reportLabel || '未命名报表'}

请基于以下数据进行深入分析，并给出**实用、可执行**的业务建议和行动项。

**当前筛选条件**：
{filters}

{context}

请严格以以下JSON格式回复（必须是合法JSON，不要添加任何额外文字、markdown或解释）：

{
  "overview": "一句话业务概览，突出最重要发现和趋势",
  "keyMetrics": [
    {"label": "指标名", "value": "数值或百分比", "change": "↑12% 或 ↓5%"}
  ],
  "insights": ["洞察1 - 必须包含具体数据支持", "洞察2"],
  "anomalies": ["发现的异常情况1（带量化理由和建议）"],
  "recommendations": [
    "具体、可执行的行动建议1 - 标注优先级",
    "具体、可执行的行动建议2"
  ],
  "suggestedHighlights": ["列名:异常阈值", "条件:大于X% 或 其他过滤建议"]
}

重点关注效率、质量、成本、进度、风险和可执行的改进点。根据不同领域调整重点。
`;
  }

  generateMetrics(data) {
    if (!data || !data.rows || data.rows.length === 0) {
      return '无数据';
    }
    // Simple stats - can be extended with more sophisticated calculations
    const rowCount = data.rows.length;
    return `总记录数: ${rowCount}\n列数: ${(data.columns || []).length}`;
    // TODO: Add more sophisticated stats based on numeric columns
  }

  generateDataSample(rows, limit = 5) {
    if (!rows || rows.length === 0) return '无数据样本';
    const sampleRows = rows.slice(0, Math.min(limit, rows.length));
    return JSON.stringify(sampleRows, null, 2);
  }

  /** 兼容 string / 多段 content 数组（部分供应商返回格式不同） */
  static extractChatTextContent(message) {
    if (!message || message.content == null) return '';
    const c = message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map(function (part) {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            if (typeof part.text === 'string') return part.text;
            if (typeof part.content === 'string') return part.content;
          }
          return '';
        })
        .join('');
    }
    return String(c);
  }

  /**
   * Generate high-quality ai_prompt template from natural language description
   * Only used by admin "AI Prompt Generator" feature.
   * @param {string} description - Natural language business requirement (e.g. "采购订单到期分析，需要体现正常和超期...")
   * @param {string} [reportType=''] - Optional report type to make prompt more specific
   * @returns {Promise<{success: boolean, prompt: string, error?: string}>}
   */
  async generatePromptTemplate(description, reportType = '') {
    if (!description || typeof description !== 'string' || description.trim().length < 5) {
      return {
        success: false,
        error: '描述内容太短或无效，请输入有意义的业务需求描述'
      };
    }

    const configuredKey = this.getConfiguredApiKey();
    if (!configuredKey) {
      const hint = this.expectedKeyHint();
      return {
        success: false,
        error: `未检测到 ${hint}。请写入 server/.env 或仓库根目录 .env 后重启服务（当前 AI_PROVIDER=${this.provider}）。`,
      };
    }

    const model = this.defaultModel;
    const systemPrompt = `你是一个专业的Prompt Engineer，专门为生产制造/报工系统的AI分析功能生成高质量的ai_prompt模板。

你的任务是：根据用户提供的**业务描述**，生成一个结构良好、具体、可重用的 ai_prompt 模板。

要求：
1. 必须使用以下占位符（这些会在运行时被自动替换）：
   - {report_label}：报表名称
   - {filters}：当前筛选条件（JSON）
   - {context}：关键统计指标 + 数据样本（前5行）+ 列信息
2. 必须要求模型**严格返回合法JSON**，不要返回markdown
3. JSON Schema 中应包含：overview, keyMetrics, insights, anomalies, recommendations, suggestedHighlights
4. Prompt 要具体、业务导向，结合用户描述的重点（如到期分析、超期率、DocDueDate对比等）
5. 语言专业且清晰，使用中文
6. 正文必须使用真实换行分段；不要使用字面量 \\n、\\r\\n 这类转义字符来代替换行

请直接返回一个完整的、可直接复制到菜单管理中的 ai_prompt 字符串。`;

    try {
      console.log(`[AI] Generating prompt template for: ${reportType || 'general'}...`);

      const completion = await this.client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: `业务描述：${description}\n\n报表类型：${reportType || '通用报表'}\n\n请生成专业的ai_prompt模板：`
          }
        ],
        temperature: 0.3,
        max_tokens: 1200,
      });

      const choice = completion.choices && completion.choices[0];
      let generatedPrompt = AIService.extractChatTextContent(choice && choice.message).trim();

      if (!generatedPrompt) {
        return {
          success: false,
          error: 'AI 返回内容为空，请重试或检查 AI_DEFAULT_MODEL 是否与当前供应商兼容',
        };
      }

      // Clean up if model wrapped it in markdown
      if (generatedPrompt.includes('```')) {
        generatedPrompt = generatedPrompt.replace(/```[\s\S]*?\n([\s\S]*?)```/g, '$1').trim();
      }

      // 部分模型会输出字面量 \n，在文本框中应显示为真实换行
      generatedPrompt = generatedPrompt
        .replace(/\r\n/g, '\n')
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');

      if (!generatedPrompt) {
        return {
          success: false,
          error: 'AI 返回内容在清洗后为空，请重试',
        };
      }

      return {
        success: true,
        prompt: generatedPrompt,
        model: this.provider + '/' + model
      };
    } catch (error) {
      console.error('[AI] Error generating prompt template:', error.message);
      return {
        success: false,
        error: error.message || '生成 Prompt 模板失败',
        fallback: '无法自动生成 Prompt，请参考 README.md 中的标准示例手动编写。'
      };
    }
  }

  /**
   * AI 辅助生成 Skill 内容（name / description / bodyMd）。
   * @param {string} requirement 用户对 Skill 的需求描述
   * @returns {Promise<{success: boolean, skill?: {name: string, description: string, bodyMd: string}, error?: string}>}
   */
  async generateSkillContent(requirement) {
    if (!requirement || typeof requirement !== 'string' || requirement.trim().length < 5) {
      return { success: false, error: '需求描述太短，请至少输入 5 个字符' };
    }
    const configuredKey = this.getConfiguredApiKey();
    if (!configuredKey) {
      return { success: false, error: `未配置 AI API Key（AI_PROVIDER=${this.provider}）` };
    }

    const systemPrompt = `你是一个 AI Agent Skill 编写专家。用户会描述一个业务需求，你需要生成一个完整的 Skill 定义。

Skill 用于指导 AI Agent 执行特定工作流。请严格按以下 JSON 格式返回（不要包裹在 markdown 代码块中）：

{
  "name": "小写字母开头、仅含小写字母/数字/连字符，最长64字符，如 report-analysis",
  "description": "一句话描述此 Skill 的用途和触发条件（注入 AI 提示，决定何时使用此 Skill）",
  "bodyMd": "Markdown 格式的工作流正文，描述具体执行步骤、规范和约束"
}

bodyMd 编写规范：
- 使用 Markdown 标题分段（## 目标、## 步骤、## 约束等）
- 步骤要具体、可操作
- 不要包含可执行脚本代码块（bash/python 等）
- 语言使用中文`;

    try {
      const completion = await this.client.chat.completions.create({
        model: this.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `需求描述：${requirement.trim()}` },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      });

      let text = AIService.extractChatTextContent(completion.choices?.[0]?.message).trim();
      if (!text) return { success: false, error: 'AI 返回内容为空，请重试' };

      // Strip markdown code fences if present
      text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

      let parsed;
      try { parsed = JSON.parse(text); } catch {
        return { success: false, error: 'AI 返回格式异常，请重试' };
      }

      const name = String(parsed.name || '').trim().toLowerCase();
      const description = String(parsed.description || '').trim();
      const bodyMd = String(parsed.bodyMd || parsed.body_md || '').trim()
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t');

      if (!name || !description || !bodyMd) {
        return { success: false, error: 'AI 生成内容不完整，请重试' };
      }

      return { success: true, skill: { name, description, bodyMd } };
    } catch (error) {
      return { success: false, error: error.message || '生成 Skill 失败' };
    }
  }

  async generateWriteTarget(requirement) {
    if (!requirement || typeof requirement !== 'string' || requirement.trim().length < 5) {
      return { success: false, error: '需求描述太短，请至少输入 5 个字符' };
    }
    const configuredKey = this.getConfiguredApiKey();
    if (!configuredKey) {
      return { success: false, error: `未配置 AI API Key（AI_PROVIDER=${this.provider}）` };
    }

    const systemPrompt = `你是一个数据库写入目标配置专家。用户会描述一个业务需求，你需要生成一个写入目标的配置。

写入目标用于 AI Agent 向数据库安全地写入数据（白名单字段参数化 INSERT）。请严格按以下 JSON 格式返回（不要包裹在 markdown 代码块中）：

{
  "name": "小写字母开头、仅含小写字母/数字/连字符，如 order-note",
  "label": "中文显示名，如 订单备注",
  "targetTable": "目标数据库表名，仅字母/数字/下划线，如 X_ORDER_NOTE",
  "fields": [
    {"name": "列名", "label": "中文标签", "sqlType": "nvarchar|int|decimal|datetime|bit", "required": true, "maxLen": 255}
  ]
}

规则：
- targetTable 建议以 X_ 前缀命名（自定义表，不影响 SAP 标准表）
- fields 中每个字段必须有 name、label、sqlType、required、maxLen（nvarchar 类型需要 maxLen）
- sqlType 只能是：nvarchar、int、decimal、datetime、bit
- 字段命名用英文 PascalCase（如 NoteText、DocEntry）`;

    try {
      const completion = await this.client.chat.completions.create({
        model: this.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `需求描述：${requirement.trim()}` },
        ],
        temperature: 0.3,
        max_tokens: 1500,
      });

      let text = AIService.extractChatTextContent(completion.choices?.[0]?.message).trim();
      if (!text) return { success: false, error: 'AI 返回内容为空，请重试' };
      text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

      let parsed;
      try { parsed = JSON.parse(text); } catch {
        return { success: false, error: 'AI 返回格式异常，请重试' };
      }

      const name = String(parsed.name || '').trim().toLowerCase();
      const label = String(parsed.label || '').trim();
      const targetTable = String(parsed.targetTable || '').trim();
      const fields = Array.isArray(parsed.fields) ? parsed.fields : [];

      if (!name || !label || !targetTable || fields.length === 0) {
        return { success: false, error: 'AI 生成内容不完整，请重试' };
      }

      return { success: true, target: { name, label, targetTable, fields } };
    } catch (error) {
      return { success: false, error: error.message || '生成写入目标失败' };
    }
  }
}

const aiService = new AIService();

/**
 * Factory for easy reuse in other projects. Returns a configured instance.
 * @param {Object} options See AIService constructor for details.
 */
function createAIService(options = {}) {
  return new AIService(options);
}

module.exports = { 
  aiService, 
  AIService, 
  createAIService,
  // For advanced use
  trimEnv 
};
