import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createInitialState, getSocketQueue, type TaggedTcpSocket } from "rusty-motors-shared";
import { loggerMock } from "rusty-motors-shared/test";
import { npsPortRouter } from "../src/npsPortRouter.js";
import { mcotsPortRouter } from "../src/mcotsPortRouter.js";

vi.mock("rusty-motors-lobby", () => ({ receiveLobbyData: vi.fn() }));
vi.mock("rusty-motors-authentication", () => ({ receiveLoginData: vi.fn(), receivePersonaData: vi.fn() }));
vi.mock("rusty-motors-chat", () => ({ receiveChatData: vi.fn() }));

type Router = (parameters: { taggedSocket: TaggedTcpSocket; log: typeof loggerMock }) => Promise<void>;

// The routers' message queues are the only code here that waits on a 10 ms timer; each idle poll is one such call.
const queueTickMs = 10;
const realSetTimeout = globalThis.setTimeout;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => realSetTimeout(resolve, ms));
}

describe("port routers stop their message queues when the socket closes", () => {
	let server: Server;
	let port: number;
	let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

	function queuePollsDuring(ms: number): Promise<number> {
		setTimeoutSpy.mockClear();
		return wait(ms).then(() => setTimeoutSpy.mock.calls.filter((call) => call[1] === queueTickMs).length);
	}

	beforeEach(async () => {
		createInitialState({ saveFunction: () => {} });
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		server = createServer();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		setTimeoutSpy.mockRestore();
		server.close();
		await once(server, "close");
	});

	async function openRoutedConnection(router: Router, connectionId: string): Promise<{ client: Socket; serverSocket: Socket }> {
		const accepted = once(server, "connection");
		const client = connect(port, "127.0.0.1");
		const [serverSocket] = (await accepted) as [Socket];
		await router({
			taggedSocket: { socket: serverSocket, connectionId, connectedAt: Date.now(), localPort: port },
			log: loggerMock,
		});
		return { client, serverSocket };
	}

	const routers: Array<[string, Router]> = [
		["npsPortRouter", npsPortRouter as Router],
		["mcotsPortRouter", mcotsPortRouter as Router],
	];

	for (const [name, router] of routers) {
		it(`${name}: no queue keeps polling after the client hangs up cleanly`, async () => {
			const { client, serverSocket } = await openRoutedConnection(router, `${name}-clean:${port}`);
			expect(await queuePollsDuring(50)).toBeGreaterThan(0);

			const closed = once(serverSocket, "close");
			client.end();
			await closed;
			await wait(queueTickMs * 3);

			expect(await queuePollsDuring(50)).toBe(0);
		});

		it(`${name}: no queue keeps polling after the server destroys the socket`, async () => {
			const { client, serverSocket } = await openRoutedConnection(router, `${name}-destroy:${port}`);
			expect(await queuePollsDuring(50)).toBeGreaterThan(0);

			const closed = once(serverSocket, "close");
			serverSocket.destroy();
			await closed;
			await wait(queueTickMs * 3);
			client.destroy();

			expect(await queuePollsDuring(50)).toBe(0);
		});
	}

	it("npsPortRouter: a closed connection's queue pair is removed", async () => {
		const connectionId = `nps-pair:${port}`;
		const { client, serverSocket } = await openRoutedConnection(npsPortRouter as Router, connectionId);
		expect(getSocketQueue(connectionId, "send")).toBeDefined();

		const closed = once(serverSocket, "close");
		client.end();
		await closed;

		expect(() => getSocketQueue(connectionId, "send")).toThrow(`Unable to locate queue pair for connection: ${connectionId}`);
	});
});
