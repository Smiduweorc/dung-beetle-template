# Live examples

`npm run live` generates a client for three real public APIs, one per
protocol, and calls each of them over the network. None needs credentials.

| Protocol | API | Description read | Endpoint called |
| --- | --- | --- | --- |
| OpenAPI | Arch User Repository | <https://aur.archlinux.org/rpc/openapi.json>, fetched each run | `https://aur.archlinux.org` |
| OpenRPC | Ethereum mainnet | `ethereum.openrpc.json`, three methods from [execution-apis](https://github.com/ethereum/execution-apis) | `https://ethereum-rpc.publicnode.com` |
| gRPC | Connect's Eliza demo | `protos/connectrpc/eliza/v1/eliza.proto`, from [buf.build/connectrpc/eliza](https://buf.build/connectrpc/eliza) | `https://demo.connectrpc.com`, over gRPC and Connect |

`live.ts` writes the generated code and a copy of the runtime to
`examples/.generated/` (ignored by git), type-checks `calls.ts` against it,
then runs it. `calls.ts` is what a consumer of each client writes:

```
openapi  searchPackages("neovim")   292 results, first goneovim-bin
openapi  getPackage("yay")          13.1.0-1, 2649 votes
openrpc  chainId, blockNumber       0x1, block 26366577
openrpc  getBalance(deposit)        93153390 ETH
openrpc  getBalance("0xnot-…")      refused: RpcError
grpc     say                        When you feel like testing a real api, what do you do?
grpc     introduce (server stream)  4 messages
connect  say                        Feeling like testing a real api? Tell me more.
connect  introduce (server stream)  4 messages
```

It shows:

- Names fixed through the `names` map: AUR paths all start with `/rpc/v5/`
  and `eth_` methods would otherwise come out as `ethGetBalance`.
- Typed query parameters (`by: "name"` is one of the AUR's 14 values) and
  typed JSON-RPC params.
- An `RpcError` for a call the node refuses.
- Unary and server-streaming gRPC calls through `@connectrpc/connect-node`.

It is kept out of `npm test` and the pull request checks because it depends on
three services nobody here runs. The weekly `corpus` workflow runs it. A
failure there means an API changed or is down, which is worth knowing, but not
worth blocking a pull request over.
