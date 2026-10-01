# Directory submission checklist

Public-directory listing is a separate deliverable from a working endpoint. Nothing here has been submitted, and no directory or install link exists. If publication is blocked, the MCP server remains usable as a standalone project.

## Open risks

- **Unofficial third-party connectors.** OpenAI's plugin guidelines restrict unofficial third-party connectors and pass-through layers. This service is a thin layer over Google PageSpeed Insights, so a submission carries a material risk of rejection. Neither normalization nor branding guarantees an exception. Recheck the current guidelines before submitting.
- **Naming permission.** “Lighthouse Audit” is a working name, not a statement of trademark clearance. Review Google's branding guidance and OpenAI's naming and IP requirements. Neither descriptive wording nor the independence notice grants permission.
- **Google API terms.** Review the PageSpeed Insights API terms for this use, including anonymous public access through one project key.

## Before submitting

- [ ] Endpoint live with audits enabled, smoke checks recorded in DEPLOYMENT.md
- [ ] Tested in MCP Inspector and in ChatGPT developer mode; no external login required
- [ ] Client timeout behavior measured against typical audit durations
- [ ] Privacy page and support contact approved and published
- [x] License selected: MIT
- [ ] Current OpenAI submission and review requirements rechecked
- [ ] Naming and branding review done
- [ ] Google API terms reviewed

## Factual listing copy

| Element | Copy |
| ------- | ---- |
| Name | Lighthouse Audit |
| Subtitle | Fresh website performance, accessibility, and SEO checks. No separate signup. |
| Description | Run fresh Lighthouse website audits for performance, accessibility, SEO, and best practices via PageSpeed Insights. No separate signup. |
| Provider attribution | Uses Lighthouse via Google PageSpeed Insights. |
| Independence notice | Independently developed by Reinhard Zach; not affiliated with Google or OpenAI. |
| Endpoint | `https://audit.mrza.ch/mcp` (Streamable HTTP, no authentication) |
| Website | `https://audit.mrza.ch/` |
| Privacy | `https://audit.mrza.ch/privacy` |

Facts to state accurately:

- One tool, `run_lighthouse`, read-only, not idempotent (every call is a fresh measurement), open-world (sends the URL to Google).
- Each call makes one new PageSpeed Insights request for one page on one device. No caching, history, crawling or monitoring.
- Lab measurements only, not real-user Core Web Vitals.
- The upstream dependency is Google PageSpeed Insights, operated with the developer's own API key and quota. Capacity is limited by that quota.

Do not claim the service is an official Google product, promise approval or discoverability, or advertise unsupported features such as site crawls, backlink analysis, rankings or real-user INP.
