// 全局变量
const OLLAMA_HOSTNAME = 'localhost';
const OLLAMA_PORT = 11434;
const OLLAMA_MODEL = 'deepseek-r1:14b';

const http = require('http');
const { hostname } = require('os');

/**
 * 简单检测文本语言，如果包含日文字符则认为是日文，
 * 如果包含中文字符则认为是中文，否则认为是英语
 * @param {string} text
 * @returns {string} 返回检测出的语言名称（如 "中文(简体)"、"日语" 或 "英语"）
 */
function detectLanguage(text) {
  if (/[\u3040-\u30FF]/.test(text)) {
    return "日语";
  }
  return /[\u4e00-\u9fa5]/.test(text) ? "中文(简体)" : "英语";
}

/**
 * 调用 OLLAMA 的 API 获取翻译结果，并转换为划词翻译需要的格式
 * @param {Object} params - 划词翻译传递的参数
 * @param {string} params.text - 需要翻译的文本
 * @param {string[]} params.destination - 目标语种（数组，第一个为首选）
 * @param {string} [params.source] - 源语种（可能为空，此时接口可自行判断语种）
 * @returns {Promise<Object>} 返回划词翻译要求的 JSON 格式
 */
function getResultFromOLLAMA(params) {
  if (!params.destination || params.destination.length === 0) {
    return Promise.reject(new Error('destination 数组为空'));
  }

  // 内部函数：依次尝试 candidateList 中的每个候选语种
  function tryCandidate(candidateList) {
    if (candidateList.length === 0) {
      // 所有候选均无效，返回原文
      return Promise.resolve({
        text: params.text,
        from: params.source || '',
        to: '',
        link: '',
        result: [params.text]
      });
    }

    const candidate = candidateList[0];
    const detectedLang = detectLanguage(params.text);
    // 如果传入了 source 并且候选与 source 相同，或者未传入 source 且候选与检测结果一致，则跳过此候选
    if ((params.source && params.source === candidate)
      || (!params.source && candidate === detectedLang)
    ) {
      // 直接尝试下一个候选语种
      return tryCandidate(candidateList.slice(1));
    }

    // 构造翻译提示
    let prompt;
    if (params.source && params.source !== "auto" && params.source !== "") {
      prompt = `Translate the following text from ${params.source} to ${candidate}:\n\n${params.text}`;
    } else {
      prompt = `Translate the following text to ${candidate}:\n\n${params.text}`;
    }

    // 构造调用 OLLAMA 接口的 POST 数据（非流式返回）
    const postData = JSON.stringify({
      model: OLLAMA_MODEL,  // 使用全局变量
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0
      }
    });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: OLLAMA_HOSTNAME,  // 使用全局变量
        port: OLLAMA_PORT,          // 使用全局变量
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            // 获取 OLLAMA 返回的翻译文本
            let translationText = json.response || "";
            // 去除所有 <think>...</think> 包围的部分（包括跨多行的情况）
            translationText = translationText.replace(/<think>[\s\S]*?<\/think>/g, '');
            // 清理后拆分成多个段落
            const resultArray = translationText
              .split('\n')
              .map(line => line.trim())
              .filter(line => line !== '');

            // 如果清理后的翻译结果为空或与原文完全一致，则尝试下一个候选
            if (resultArray.join('') === "" || resultArray.join('') === params.text.trim()) {
              return resolve(tryCandidate(candidateList.slice(1)));
            }

            return resolve({
              text: params.text,
              from: params.source || '',
              to: candidate,
              link: 'localhost:11434',
              result: resultArray
            });
          } catch (err) {
            return reject(err);
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(postData);
      req.end();
    });
  }

  return tryCandidate(params.destination);
}

/**
 * 处理 GPT 风格的聊天请求，调用 OLLAMA 模型并将其转换为 GPT 风格响应
 * @param {Object} gptRequest - GPT 风格的请求体
 * @returns {Promise<Object>} GPT 风格的响应
 */
function handleChatRequest(gptRequest) {
  const params = {
    text: gptRequest.messages[0].content,  // 处理消息中的内容
    destination: ['中文(简体)']  // 目标语言为中文(简体)，您可以根据需要修改
  };

  return getResultFromOLLAMA(params)
    .then(ollamaResponse => {
      // 将 OLLAMA 的响应转换为 GPT 风格的响应格式
      return {
        id: gptRequest.id,
        object: 'chat.completion',
        created: Date.now(),
        model: OLLAMA_MODEL,  // 使用全局变量
        choices: [
          {
            message: {
              role: 'assistant',
              content: ollamaResponse.result.join('\n')
            },
            finish_reason: 'stop',
            index: 0
          }
        ]
      };
    });
}

// 创建 HTTP 服务器，用于响应划词翻译的 POST 请求
http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      console.log(`[${new Date().toISOString()}] Request Body: ${body}`);
      try {
        const params = JSON.parse(body);

        // 处理 GPT 风格 API 的请求
        if (req.url === '/api/chat') {
          handleChatRequest(params)
            .then(chatResponse => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(chatResponse));
            })
            .catch(error => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: error.message }));
            });
          return;
        }

        if (params.name === 'OLLAMA') {
          getResultFromOLLAMA(params)
            .then(translationResult => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(translationResult));
            })
            .catch(error => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: error.message }));
            });
          return;
        }

        res.writeHead(404);
        res.end();
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(8088, () => {
  console.log('Server is listening on port 8088');
});