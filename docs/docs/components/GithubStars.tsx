export const GithubStars = ({ repo }: { repo: string }) => {
  const repoId = `github-stars-${repo.replace("/", "-")}`;

  return (
    <div>
      <a
        href={`https://github.com/${repo}`}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-accent"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.5rem",
          textDecoration: "none",
          fontSize: "14px",
          fontWeight: "500",
        }}
      >
        <svg
          role="img"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          aria-label="GitHub"
          fill="currentColor"
        >
          <title>GitHub</title>
          <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
        </svg>
        <span className="font-medium">{repo}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="lucide lucide-star-icon lucide-star"
          aria-label="Stars"
          role="img"
        >
          <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
        </svg>
        <span style={{ fontWeight: "300" }} id={repoId} />
      </a>
    </div>
  );
};

export const GithubStarsScript = ({ repo }: { repo: string }) => {
  const repoId = `github-stars-${repo.replace("/", "-")}`;

  return (
    <script
      // biome-ignore lint/security/noDangerouslySetInnerHtml: <explanation>
      dangerouslySetInnerHTML={{
        __html: `
            (function() {
              const repoId = '${repoId}';
              const repo = '${repo}';

              async function fetchStarCount() {
                await new Promise(resolve => setTimeout(resolve, 100));
                try {
                  const response = await fetch('/github-api/repos/' + repo);
                  if (!response.ok) {
                    throw new Error('Failed to fetch repository data');
                  }
                  const data = await response.json();
                  const element = document.getElementById(repoId);
                  if (element) {
                    element.textContent = data.stargazers_count.toLocaleString();
                  }
                } catch (error) {
                  console.error('Error fetching GitHub stars:', error);
                  const element = document.getElementById(repoId);
                  if (element) {
                    element.textContent = '-';
                  }
                }
              }

              // Run when DOM is ready
              if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', fetchStarCount);
              } else {
                fetchStarCount();
              }
            })();
          `,
      }}
    />
  );
};
