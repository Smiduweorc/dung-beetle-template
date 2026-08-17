import type {
	NormalizedDocument,
	SpecOAuth2Scheme,
	SpecSecurityRequirement,
	SpecSecurityScheme,
} from "./model.js";

// Documents how to authenticate, and emits no code for it. The one fact only
// the document holds is where the credential goes and under exactly what name:
// `X-API-Key` against `api-key` against `apikey` is a real debugging session.
// Everything else is standard-library knowledge, and a generated `bearerAuth()`
// helper would save one object literal in exchange for a permanent export and
// the impression that this package does auth.

/**
 * The authentication notes for a document, as markdown.
 *
 * No heading: the notes go between markers a person put in their own README,
 * and only that person knows what heading level belongs there.
 */
export function securityNotes(document: NormalizedDocument): string {
	if (document.securitySchemes.length === 0) {
		return `${document.title} declares no security schemes.`;
	}

	const rows = document.securitySchemes.map(
		(scheme) => `| \`${scheme.name}\` | ${kindOf(scheme)} | ${whereOf(scheme)} |`
	);
	const notes = document.securitySchemes
		.map((scheme) => noteFor(scheme))
		.filter((note) => note !== undefined);

	return [
		`Written from ${document.title}'s own document. No credential handling is`,
		"generated: a credential is a header, so it reaches the API through",
		"`ApiClient`'s `headers`, or through `RequestOptions.headers` per call. Each",
		"generated function repeats the schemes that apply to it on its `@security`",
		"line.",
		"",
		applies(document.security),
		"",
		"| Scheme | Kind | Where the credential goes |",
		"| --- | --- | --- |",
		...rows,
		...notes.flatMap((note) => ["", note]),
	].join("\n");
}

function applies(security: readonly SpecSecurityRequirement[]): string {
	if (security.length === 0) {
		return "The document requires nothing by default, so what an endpoint needs is on the endpoint.";
	}

	const alternatives = security.map((requirement) => {
		const names = Object.keys(requirement).map((name) => `\`${name}\``);

		return names.length > 1 ? names.join(" and ") : (names[0] ?? "nothing");
	});

	return `Every endpoint requires ${list(alternatives, "or")} unless it says otherwise.`;
}

function kindOf(scheme: SpecSecurityScheme): string {
	switch (scheme.kind) {
	case "http":
		return `\`http\`, ${scheme.scheme}${scheme.bearerFormat ? ` (${scheme.bearerFormat})` : ""}`;
	case "apiKey":
		return `\`apiKey\` in ${scheme.in}`;
	default:
		return `\`${scheme.kind}\``;
	}
}

function whereOf(scheme: SpecSecurityScheme): string {
	switch (scheme.kind) {
	case "http":
		if (scheme.scheme === "basic") {
			return "Header `authorization: Basic <base64 of user:password>`";
		}
		return scheme.scheme === "bearer"
			? "Header `authorization: Bearer <token>`"
			: `Header \`authorization: ${titleCase(scheme.scheme)} <credentials>\``;
	case "apiKey":
		return `${scheme.in === "query" ? "Query parameter" : titleCase(scheme.in)} \`${scheme.parameterName}\``;
	case "oauth2":
	case "openIdConnect":
		return "Header `authorization: Bearer <token>`";
	case "mutualTLS":
		return "A client certificate, on the transport";
	}
}

/** The extra sentence a scheme needs, where the table row does not say enough. */
function noteFor(scheme: SpecSecurityScheme): string | undefined {
	const described = scheme.description ? `${scheme.description.trim()} ` : "";

	switch (scheme.kind) {
	case "apiKey":
		if (scheme.in === "query") {
			return `**\`${scheme.name}\`** ${described}\`ApiClient\` sends no query of its own, so a transport decorator has to append \`${scheme.parameterName}\` to the request URL.`;
		}
		if (scheme.in === "cookie") {
			return `**\`${scheme.name}\`** ${described}A browser will not let \`fetch\` set a cookie, so this works from a server or through a transport decorator.`;
		}
		return described === "" ? undefined : `**\`${scheme.name}\`** ${described.trim()}`;
	case "oauth2":
		return `**\`${scheme.name}\`** ${described}${flows(scheme)} A token that expires goes through \`withBearerToken\` from the \`/transport\` subpath, which asks for a new one and shares that call between concurrent requests.`;
	case "openIdConnect":
		return `**\`${scheme.name}\`** ${described}The provider is discovered at ${scheme.discoveryUrl}. A token that expires goes through \`withBearerToken\` from the \`/transport\` subpath.`;
	case "mutualTLS":
		return `**\`${scheme.name}\`** ${described}Client certificates are configured on whatever \`fetch\`-shaped function you pass as the transport, not here.`;
	case "http":
		return described === "" ? undefined : `**\`${scheme.name}\`** ${described.trim()}`;
	}
}

function flows(scheme: SpecOAuth2Scheme): string {
	return scheme.flows
		.map((flow) => {
			const urls = [
				flow.authorizationUrl ? `authorize at ${flow.authorizationUrl}` : undefined,
				flow.tokenUrl ? `take a token from ${flow.tokenUrl}` : undefined,
				flow.refreshUrl ? `refresh at ${flow.refreshUrl}` : undefined,
			].filter((url) => url !== undefined);
			const scopes = Object.keys(flow.scopes).map((scope) => `\`${scope}\``);
			const scoped = scopes.length > 0 ? ` Scopes: ${list(scopes, "and")}.` : "";

			return `${titleCase(spaced(flow.kind))} flow: ${list(urls, "and")}.${scoped}`;
		})
		.join(" ");
}

function spaced(kind: string): string {
	return kind.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
}

function list(items: readonly string[], conjunction: string): string {
	if (items.length <= 1) {
		return items.join("");
	}

	return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1) ?? ""}`;
}

function titleCase(value: string): string {
	return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
