import { defineConfig } from "vocs";
import { GithubStars } from "./docs/components/GithubStars";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  title: "Scenario",
  description: "Agent Testing Framework",
  logoUrl: "/images/logo.png",
  iconUrl: "/favicon.ico",
  ogImageUrl:
    "https://langwatch.mintlify.app/api/og?division=Documentation&mode=system&title=%title&description=%description&logoLight=https://scenario.langwatch.ai/images/logo.png&logoDark=https://scenario.langwatch.ai/images/logo.png&primaryColor=%232D1720&lightColor=%23EDC790&darkColor=%23EDC790&amp;w=1200&amp;q=100",
  head: (
    <>
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
    </>
  ),
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
          link: "/",
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
      text: "Scenario Basics",
      items: [
        {
          text: "Concepts",
          link: "/basics/concepts",
        },
        {
          text: "Writing Scenarios",
          link: "/basics/writing-scenarios",
        },
        {
          text: "Scripted Simulations",
          link: "/basics/scripted-simulations",
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
      ],
    },
    {
      text: "API Reference",
      items: [
        {
          text: "Python",
          link: `${process.env.BASE_URL ?? "http://localhost:5173"}${
            process.env.BASE_PATH ?? ""
          }/reference/python/scenario/index.html`,
        },
        {
          text: "TypeScript",
          link: `${process.env.BASE_URL ?? "http://localhost:5173"}${
            process.env.BASE_PATH ?? ""
          }/reference/javascript/scenario/index.html`,
        },
      ],
    },
  ],
  basePath: process.env.BASE_PATH,
  baseUrl: process.env.BASE_URL,
  topNav: [
    {
      element: GithubStars({ repo: "langwatch/scenario" }),
    },
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
