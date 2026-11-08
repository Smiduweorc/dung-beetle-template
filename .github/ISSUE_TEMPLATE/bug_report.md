---
name: Bug report
about: The generator or the client did something wrong
---

**Generator or client?**

**For the generator: the document, and what it printed**

A URL, or the smallest excerpt of the document that still fails. Paste the
full output of `npm run generate`.

**For the client: the call and the error**

The operation you sent (tokens and keys removed), the error class
(`TransportError`, `HttpError`, `DecodeError`) and its `status`.

**What you expected**

**Environment**

- Template commit: [`git rev-parse --short HEAD`]
- Node.js version: [e.g. 22.11.0]
- OS: [e.g. Ubuntu 24.04, Windows 11, macOS 15]
