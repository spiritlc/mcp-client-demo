import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import * as readline from 'readline';

dotenv.config(); // 加载 .env 文件中的环境变量

class MCPClient {
    private openai: OpenAI;
    private client: Client;
    private messages: ChatCompletionMessageParam[] = [
        {
            role: "system",
            content: "You are a helpful assistant that can answer questions and help with tasks."
        },
    ];
    private availableTools: any[] = [];

    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseURL: process.env.OPENAI_BASE_URL,
        });
        this.client = new Client(
            {
                name: "mcp-typescript-client",
                version: "1.0.0",
            },
        );
    }

    async connectToServer(serverScriptPath: string) {
        const isPython = serverScriptPath.endsWith('.py');
        const isJs = serverScriptPath.endsWith('.js');

        if (!isPython && !isJs) {
            throw new Error("Server script must be a .py or .js file");
        }

        const command = isPython ? "python" : "node";

        const transport = new StdioClientTransport({
            command,
            args: [serverScriptPath],
        });

        await this.client.connect(transport);

        // 获取并转换可用工具列表
        const tools = (await this.client.listTools()).tools as unknown as Tool[];
        this.availableTools = tools.map(tool => ({
            type: "function" as const,
            function: {
                name: tool.name as string,
                description: tool.description as string,
                parameters: {
                    type: "object",
                    properties: tool.inputSchema.properties as Record<string, unknown>,
                    required: tool.inputSchema.required as string[],
                },
            }
        }));

        console.log("\nConnected to server with tools:", tools.map(tool => tool.name));
    }

    private async handleToolCalls(response: OpenAI.Chat.Completions.ChatCompletion, messages: ChatCompletionMessageParam[]) {
        let currentResponse = response;
        let counter = 0; // 避免重复打印 AI 的响应消息

        // 处理工具调用, 直到没有工具调用
        while (currentResponse.choices[0].message.tool_calls) {
            // 打印当前 AI 的响应消息
            if (currentResponse.choices[0].message.content && counter !== 0) {
                console.log("\n🤖 AI:", currentResponse.choices[0].message.content);
            }
            counter++;

            for (const toolCall of currentResponse.choices[0].message.tool_calls) {
                const toolName = toolCall.function.name;
                const toolArgs = JSON.parse(toolCall.function.arguments);

                console.log(`\n🔧 调用工具 ${toolName}`);
                console.log(`📝 参数:`, JSON.stringify(toolArgs, null, 2));

                // 执行工具调用
                const result = await this.client.callTool({
                    name: toolName,
                    arguments: toolArgs
                });

                // 添加 AI 的响应和工具调用结果到消息历史
                messages.push(currentResponse.choices[0].message);
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(result.content),
                } as ChatCompletionMessageParam);
            }

            // 获取下一个响应
            currentResponse = await this.openai.chat.completions.create({
                model: process.env.OPENAI_MODEL as string,
                messages: messages,
                tools: this.availableTools,
            });
        }

        return currentResponse;
    }

    async processQuery(query: string): Promise<string> {
        // 添加用户查询到消息历史
        this.messages.push({
            role: "user",
            content: query,
        });

        // 初始 OpenAI API 调用
        let response = await this.openai.chat.completions.create({
            model: process.env.OPENAI_MODEL as string,
            messages: this.messages,
            tools: this.availableTools,
        });

        // 打印初始响应消息
        if (response.choices[0].message.content) {
            console.log("\n🤖 AI:", response.choices[0].message.content);
        }

        // 如果有工具调用，处理它们
        if (response.choices[0].message.tool_calls) {
            response = await this.handleToolCalls(response, this.messages);
        }

        // 将最终响应添加到消息历史
        this.messages.push(response.choices[0].message);

        return response.choices[0].message.content || "";
    }

    async chatLoop() {
        console.log("\nMCP Client Started!");
        console.log("Type your queries or 'quit' to exit.");

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        while (true) {
            const query = await new Promise<string>((resolve) => {
                rl.question("\nQuery: ", resolve);
            });

            if (query.toLowerCase() === 'quit') {
                break;
            }

            try {
                const response = await this.processQuery(query);
                console.log("\n" + response);
            } catch (e) {
                console.error("\nError:", e instanceof Error ? e.message : String(e));
            }
        }

        rl.close();
    }

    async cleanup() {
        if (this.client) {
            await this.client.close();
        }
    }
}

async function main() {
    if (process.argv.length < 3) {
        console.log("Usage: ts-node src/index.ts <path_to_server_script>");
        process.exit(1);
    }

    const client = new MCPClient();
    try {
        await client.connectToServer(process.argv[2]);
        await client.chatLoop();
    } finally {
        await client.cleanup();
    }
}

main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});
