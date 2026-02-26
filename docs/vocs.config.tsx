import { defineConfig } from "vocs";
import { GithubStars } from "./docs/components/GithubStars";
import { LanguageSelectorPortal } from "./docs/components/LanguageSelectorPortal";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "vite-plugin-sitemap";

const baseUrl = process.env.BASE_URL ?? "http://localhost:5173";
const basePath = process.env.BASE_PATH ?? "";

export default defineConfig({
  title: "Scenario: Agent Testing with Simulation-Based Workflows",
  titleTemplate: "%s – Scenario",
  description:
    "Test AI agents with simulation-based testing. LLM-powered user simulators validate agent behavior, tool calling, and multi-turn conversations in LangGraph, CrewAI, Pydantic AI.",
  baseUrl,
  basePath,
  logoUrl: "/images/logo.png",
  iconUrl: "/favicon.ico",
  ogImageUrl:
    "https://langwatch.mintlify.app/api/og?division=Documentation&mode=system&title=%title&description=%description&logoLight=https://scenario.langwatch.ai/images/logo.png&logoDark=https://scenario.langwatch.ai/images/logo.png&primaryColor=%232D1720&lightColor=%23EDC790&darkColor=%23EDC790&w=1200&q=100",
  head({ path }) {
    const canonicalUrl = `${baseUrl}${path}`;

    return (
      <>
        {/* Core SEO */}
        <link rel="canonical" href={canonicalUrl} />
        <meta property="og:url" content={canonicalUrl} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Scenario" />

        {/* Twitter/Social */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@langwatchai" />
        <meta name="twitter:creator" content="@langwatchai" />

        {/* Author & Keywords */}
        <meta name="author" content="LangWatch" />
        <meta
          name="keywords"
          content="agent testing, AI agent testing, LLM testing, simulation testing, test AI agents, LangGraph testing, CrewAI testing, Pydantic AI testing, agent framework, agent evaluation"
        />

        {/* Performance */}
        <link rel="dns-prefetch" href="https://www.googletagmanager.com" />

        {/* Mobile optimization */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Scenario" />

        {/* Structured Data - Homepage */}
        {path === "/" && (
          <script type="application/ld+json">
            {JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "Scenario",
              applicationCategory: "DeveloperApplication",
              description: "Agent Testing Framework for AI Agents",
              url: baseUrl,
              operatingSystem: ["Python", "TypeScript", "JavaScript"],
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
              },
              author: {
                "@type": "Organization",
                name: "LangWatch",
                url: "https://langwatch.ai",
              },
              sameAs: [
                "https://github.com/langwatch/scenario",
                "https://x.com/langwatchai",
                "https://discord.gg/kT4PhDS2gH",
              ],
            })}
          </script>
        )}

        {/* Organization Schema */}
        <script type="application/ld+json">
          {JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Organization",
            name: "LangWatch",
            url: "https://langwatch.ai",
            logo: "https://scenario.langwatch.ai/images/logo.png",
            sameAs: [
              "https://github.com/langwatch/scenario",
              "https://x.com/langwatchai",
              "https://discord.gg/kT4PhDS2gH",
            ],
          })}
        </script>

        {/* WebSite Schema with SearchAction */}
        <script type="application/ld+json">
          {JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: "Scenario Documentation",
            url: baseUrl,
            potentialAction: {
              "@type": "SearchAction",
              target: {
                "@type": "EntryPoint",
                urlTemplate: `${baseUrl}/?search={search_term_string}`,
              },
              "query-input": "required name=search_term_string",
            },
          })}
        </script>

        {/* Breadcrumb Schema */}
        {path !== "/" && (
          <script type="application/ld+json">
            {JSON.stringify({
              "@context": "https://schema.org",
              "@type": "BreadcrumbList",
              itemListElement: [
                {
                  "@type": "ListItem",
                  position: 1,
                  name: "Home",
                  item: baseUrl,
                },
                ...path
                  .split("/")
                  .filter(Boolean)
                  .map((segment, index, arr) => ({
                    "@type": "ListItem",
                    position: index + 2,
                    name: segment
                      .replace(/-/g, " ")
                      .replace(/\b\w/g, (l) => l.toUpperCase()),
                    item: `${baseUrl}/${arr.slice(0, index + 1).join("/")}`,
                  })),
              ],
            })}
          </script>
        )}

        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
      </>
    );
  },
  theme: {
    accentColor: {
      light: "#ce2c31",
      dark: "#fc5028",
    },
  },
  editLink: {
    pattern:
      "https://github.com/langwatch/scenario/edit/main/docs/docs/pages/:path",
    text: "Suggest changes to this page",
  },
  socials: [
    {
      icon: "discord",
      link: "https://discord.gg/kT4PhDS2gH",
    },
    {
      icon: "github",
      link: "https://github.com/langwatch/scenario",
    },
    {
      icon: "x",
      link: "https://x.com/langwatchai",
    },
  ],
  sidebar: [
    {
      text: "Introduction",
      items: [
        {
          text: "What is Scenario?",
          link: "/scenario",
        },
        {
          text: "Your First Scenario",
          link: "/introduction/getting-started",
        },
        {
          text: "Simulation-Based Testing",
          link: "/introduction/simulation-based-testing",
        },
        {
          text: "Community & Support",
          link: "/community-support",
        },
      ],
    },
    {
      text: "Visualization",
      items: [
        {
          text: "Simulations Visualizer",
          link: "/visualizations",
        },
      ],
    },
    {
      text: "Scenario Basics",
      items: [
        {
          text: "Concepts",
          link: "/basics/concepts",
        },
        {
          text: "No-Code Scenario",
          link: "/basics/no-code-scenario",
        },
        {
          text: "Writing Scenarios",
          link: "/basics/writing-scenarios",
        },
        {
          text: "Judge Agent",
          link: "/basics/judge-agent",
        },
        {
          text: "User Simulator",
          link: "/basics/user-simulator",
        },
        {
          text: "Scripted Simulations",
          link: "/basics/scripted-simulations",
        },
        {
          text: "Configuration",
          link: "/basics/configuration",
        },
        {
          text: "Test Runner Integration",
          link: "/basics/test-runner-integration",
        },
        {
          text: "CI/CD Integration",
          link: "/basics/ci-cd-integration",
        },
        {
          text: "Cache",
          link: "/basics/cache",
        },
        {
          text: "Debug Mode",
          link: "/basics/debug-mode",
        },
      ],
    },
    {
      text: "Agent Integration",
      items: [
        {
          text: "Integrating Any Agent",
          link: "/agent-integration",
        },
        {
          text: "Agno",
          link: "/agent-integration/agno",
        },
        {
          text: "CrewAI",
          link: "/agent-integration/crewai",
        },
        {
          text: "Google ADK",
          link: "/agent-integration/google-adk",
        },
        {
          text: "HTTPS Integration",
          link: "/agent-integration/https",
        },
        {
          text: "Inngest AgentKit",
          link: "/agent-integration/agentkit",
        },
        {
          text: "LangGraph",
          link: "/agent-integration/langgraph",
        },
        {
          text: "LiteLLM",
          link: "/agent-integration/litellm",
        },
        {
          text: "Mastra",
          link: "/agent-integration/mastra",
        },
        {
          text: "OpenAI",
          link: "/agent-integration/openai",
        },
        {
          text: "Pydantic AI",
          link: "/agent-integration/pydantic-ai",
        },
        {
          text: "Vercel AI SDK",
          link: "/agent-integration/vercel-ai",
        },
      ],
    },
    {
      text: "Advanced",
      items: [
        {
          text: "Custom Judge",
          link: "/advanced/custom-judge",
        },
        {
          text: "Custom Clients",
          link: "/advanced/custom-clients",
        },
        {
          text: "Custom Observability",
          link: "/advanced/custom-observability",
        },
      ],
    },
    {
      text: "Best Practices",
      items: [
        {
          text: "The Agent Testing Pyramid",
          link: "/best-practices/the-agent-testing-pyramid",
        },
        {
          text: "The Vibe-Eval Loop",
          link: "/best-practices/the-vibe-eval-loop",
        },
        {
          text: "Domain-Driven TDD",
          link: "/best-practices/domain-driven-tdd",
        },
      ],
    },
    {
      text: "Examples & Guides",
      items: [
        {
          text: "Tool calling",
          link: "/testing-guides/tool-calling",
        },
        {
          text: "Fixtures",
          link: "/testing-guides/fixtures",
        },
        {
          text: "Mocks",
          link: "/testing-guides/mocks",
        },
        {
          text: "Blackbox Testing",
          link: "/testing-guides/blackbox-testing",
        },
        {
          text: "Multimodal",
          items: [
            {
              text: "Overview",
              link: "/examples/multimodal/overview",
            },
            {
              text: "Voice Agents",
              items: [
                {
                  text: "Overview",
                  link: "/examples/multimodal/testing-voice-agents",
                },
                {
                  text: "Audio → Text",
                  link: "/examples/multimodal/audio-to-text",
                },
                {
                  text: "Audio → Audio",
                  link: "/examples/multimodal/audio-to-audio",
                },
                {
                  text: "Voice-to-Voice",
                  link: "/examples/multimodal/voice-to-voice",
                },
              ],
            },
            {
              text: "Images",
              link: "/examples/multimodal/multimodal-images",
            },
            {
              text: "Files",
              link: "/examples/multimodal/multimodal-files",
            },
          ],
        },
        {
          text: "Testing Remote Agents",
          items: [
            {
              text: "Overview",
              link: "/examples/testing-remote-agents",
            },
            {
              text: "JSON Response",
              link: "/examples/testing-remote-agents/json",
            },
            {
              text: "Streaming",
              link: "/examples/testing-remote-agents/streaming",
            },
            {
              text: "Server-Sent Events (SSE)",
              link: "/examples/testing-remote-agents/sse",
            },
            {
              text: "Stateful (Thread ID)",
              link: "/examples/testing-remote-agents/stateful",
            },
          ],
        },
      ],
    },
    {
      text: "Examples",
      items: [
        {
          text: "SQL Agent",
          link: "/testing-guides/sql-agent",
        },
        {
          text: "Customer Support Agent",
          link: "/testing-guides/customer-support-agent",
        },
      ],
    },
    {
      text: "API Reference",
      items: [
        {
          text: "Python",
          link: `${baseUrl}${basePath}/reference/python/scenario/index.html`,
        },
        {
          text: "TypeScript",
          link: `${baseUrl}${basePath}/reference/javascript/scenario/index.html`,
        },
      ],
    },
  ],
  topNav: [
    {
      element: LanguageSelectorPortal(),
    },
    {
      element: GithubStars({ repo: "langwatch/scenario" }),
    },
  ],
  vite: {
    plugins: [
      tailwindcss(),
      sitemap({
        hostname: baseUrl,
        generateRobotsTxt: false,
        outDir: "docs/dist",
        readable: true,
      }),
    ],
  },
});
