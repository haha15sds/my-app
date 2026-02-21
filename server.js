import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

const cartHtml = readFileSync("public/cart-widget.html", "utf8");

// --- in-memory cart (데모용; 실제는 DB/세션/유저별 스토리지로 교체)
let cart = [];
let nextId = 1;

const reply = (message) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: { cart },
});

function createCartServer() {
  const server = new McpServer({ name: "cart-app", version: "0.1.0" });

  // UI 리소스(iframe 템플릿)
  registerAppResource(
    server,
    "cart-widget",
    "ui://widget/cart.html",
    {},
    async () => ({
      contents: [
        {
          uri: "ui://widget/cart.html",
          mimeType: RESOURCE_MIME_TYPE,
          text: cartHtml,
        },
      ],
    })
  );

  // tools
  registerAppTool(
    server,
    "get_cart",
    {
      title: "Get cart",
      description: "Returns current cart items.",
      inputSchema: {},
      _meta: { ui: { resourceUri: "ui://widget/cart.html" } },
    },
    async () => reply("")
  );

  registerAppTool(
    server,
    "add_item",
    {
      title: "Add item",
      description: "Add an item to cart.",
      inputSchema: {
        name: z.string().min(1),
        price: z.number().nonnegative(),
        qty: z.number().int().min(1),
      },
      _meta: { ui: { resourceUri: "ui://widget/cart.html" } },
    },
    async (args) => {
      const name = args?.name?.trim?.() ?? "";
      const price = Number(args?.price ?? 0);
      const qty = Number(args?.qty ?? 1);
      if (!name) return reply("상품명이 비었습니다.");

      // 동일 상품명은 합치기(데모 정책)
      const existing = cart.find((x) => x.name === name && x.price === price);
      if (existing) {
        existing.qty += qty;
        cart = [...cart];
        return reply(`수량 증가: ${name} (+${qty})`);
      }

      const item = { id: `item-${nextId++}`, name, price, qty };
      cart = [...cart, item];
      return reply(`추가됨: ${name}`);
    }
  );

  registerAppTool(
    server,
    "update_qty",
    {
      title: "Update quantity",
      description: "Update item quantity by id.",
      inputSchema: {
        id: z.string().min(1),
        qty: z.number().int().min(1),
      },
      _meta: { ui: { resourceUri: "ui://widget/cart.html" } },
    },
    async (args) => {
      const id = args?.id;
      const qty = Number(args?.qty ?? 1);
      const found = cart.find((x) => x.id === id);
      if (!found) return reply("아이템을 찾지 못했습니다.");
      cart = cart.map((x) => (x.id === id ? { ...x, qty } : x));
      return reply("수량 업데이트 완료");
    }
  );

  registerAppTool(
    server,
    "remove_item",
    {
      title: "Remove item",
      description: "Remove item from cart by id.",
      inputSchema: { id: z.string().min(1) },
      _meta: { ui: { resourceUri: "ui://widget/cart.html" } },
    },
    async (args) => {
      const id = args?.id;
      const before = cart.length;
      cart = cart.filter((x) => x.id !== id);
      if (cart.length === before) return reply("삭제 대상이 없습니다.");
      return reply("삭제 완료");
    }
  );

  registerAppTool(
    server,
    "clear_cart",
    {
      title: "Clear cart",
      description: "Clear all items in cart.",
      inputSchema: {},
      _meta: { ui: { resourceUri: "ui://widget/cart.html" } },
    },
    async () => {
      cart = [];
      return reply("카트를 비웠습니다.");
    }
  );

  registerAppTool(
    server,
    "checkout_demo",
    {
      title: "Checkout (demo)",
      description: "Demo checkout. Returns total and empties cart.",
      inputSchema: {},
      _meta: { ui: { resourceUri: "ui://widget/cart.html" } },
    },
    async () => {
      const total = cart.reduce((s, x) => s + x.price * x.qty, 0);
      cart = [];
      return {
        content: [{ type: "text", text: `체크아웃(데모): 결제 금액 ${total}원` }],
        structuredContent: { cart },
      };
    }
  );

  return server;
}

// --- HTTP wrapper (/mcp)
const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) return res.writeHead(400).end("Missing URL");
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  // CORS preflight
  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/") {
    return res.writeHead(200, { "content-type": "text/plain" }).end("Cart MCP server");
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createCartServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless demo
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`Cart MCP server listening on http://localhost:${port}${MCP_PATH}`);
});
