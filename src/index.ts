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

        // 列出可用的工具
        const tools = (await this.client.listTools()).tools as unknown as Tool[];
        console.log("\nConnected to server with tools:", tools.map(tool => tool.name));
    }

    async processQuery(query: string): Promise<string> {
        const messages: ChatCompletionMessageParam[] = [
            {
                role: "user",
                content: query,
            },
        ];

        // 获取可用工具列表
        const tools = (await this.client.listTools()).tools as unknown as Tool[];
        const availableTools = tools.map(tool => ({
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

        // 初始 OpenAI API 调用
        const response = await this.openai.chat.completions.create({
            model: process.env.OPENAI_MODEL as string,
            messages: [
                {
                    role: "system",
                    content: "You are a helpful assistant with access to tools. You must follow the schema of the tools.",
                },
                ...messages
            ],
            tools: availableTools,
        });

        const finalText: string[] = [];
        const toolResults = [];

        // 处理工具调用
        if (response.choices[0].message.tool_calls) {
            for (const toolCall of response.choices[0].message.tool_calls) {
                const toolName = toolCall.function.name;
                const toolArgs = JSON.parse(toolCall.function.arguments);

                console.log(`🔧Calling tool ${toolName} with args ${JSON.stringify(toolArgs)} `);

                // 执行工具调用
                const result = await this.client.callTool({
                    name: toolName,
                    arguments: toolArgs
                });
                toolResults.push({ call: toolName, result });

                console.log(`🔧Tool ${toolName} called successfully`);

                // 继续与工具结果的对话
                messages.push(response.choices[0].message);

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(result.content),
                } as ChatCompletionMessageParam);
            }

            // 获取下一个来自 OpenAI 的响应
            const nextResponse = await this.openai.chat.completions.create({
                model: process.env.OPENAI_MODEL as string,
                messages: [
                    {
                        role: "system",
                        content: "You are a helpful assistant with access to tools.",
                    },
                    ...messages
                ],
                tools: availableTools,
            });

            finalText.push(nextResponse.choices[0].message.content || "");
        } else {
            finalText.push(response.choices[0].message.content || "");
        }

        return finalText.join("\n");
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
