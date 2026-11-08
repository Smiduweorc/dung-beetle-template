import { createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport } from "@connectrpc/connect-node";

// What a consumer of each generated client writes. `live.ts` copies this next
// to the generated code, so the imports below resolve to what it just wrote,
// and type-checks it before running it.

import { ApiClient } from "./src/client.js";
import { HttpError } from "./src/errors.js";
import { getPackage, searchPackages } from "./src/resources/rpc.js";
import { RpcClient, RpcError } from "./src/rpc.js";
import { blockNumber, chainId, getBalance } from "./src/methods/eth.js";
import { ElizaService } from "./src/grpc/connectrpc/eliza/v1/eliza_pb.js";

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export async function run(log: (line: string) => void): Promise<void> {
	// OpenAPI. The AUR's document declares no `servers`, so the base URL is ours to give.
	const aur = new ApiClient({ baseUrl: "https://aur.archlinux.org" });

	const found = await aur.request(searchPackages("neovim", { by: "name" }));
	check((found.resultcount ?? 0) > 0, "AUR search for neovim found nothing");
	log(`openapi  searchPackages("neovim")   ${found.resultcount} results, first ${found.results?.[0]?.Name}`);

	const yay = await aur.request(getPackage("yay"));
	check(yay.results?.[0]?.Name === "yay", "AUR info for yay returned something else");
	log(`openapi  getPackage("yay")          ${yay.results[0].Version}, ${yay.results[0].NumVotes} votes`);

	// OpenRPC. Params go positionally, in the order the document lists them.
	const node = new RpcClient({ url: "https://ethereum-rpc.publicnode.com" });

	const chain = await node.request(chainId());
	check(chain === "0x1", `expected mainnet (0x1), got ${chain}`);
	const head = await node.request(blockNumber());
	log(`openrpc  chainId, blockNumber       ${chain}, block ${BigInt(head)}`);

	// The deposit contract holds millions of ether, so its balance is never zero.
	const deposit = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
	const balance = await node.request(getBalance({ address: deposit, block: "latest" }));
	log(`openrpc  getBalance(deposit)        ${BigInt(balance) / 10n ** 18n} ETH`);

	try {
		await node.request(getBalance({ address: "0xnot-an-address", block: "latest" }));
		throw new Error("a malformed address was accepted");
	} catch (error) {
		check(error instanceof RpcError || error instanceof HttpError, `unexpected ${String(error)}`);
		log(`openrpc  getBalance("0xnot-…")      refused: ${error.constructor.name}`);
	}

	// gRPC, over both protocols the demo server speaks.
	const baseUrl = "https://demo.connectrpc.com";
	for (const [label, transport] of [
		["grpc   ", createGrpcTransport({ baseUrl })],
		["connect", createConnectTransport({ baseUrl, httpVersion: "1.1" })],
	] as const) {
		const eliza = createClient(ElizaService, transport);
		const { sentence } = await eliza.say({ sentence: "I feel like testing a real API." });
		check(sentence.length > 0, "Eliza said nothing");
		log(`${label}  say                        ${sentence}`);

		let lines = 0;
		for await (const _ of eliza.introduce({ name: "dung beetle" })) lines += 1;
		check(lines > 0, "Eliza streamed nothing");
		log(`${label}  introduce (server stream)  ${lines} messages`);
	}
}
