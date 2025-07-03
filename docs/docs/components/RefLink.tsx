export const RefLink = ({
  link,
  code,
  children,
}: {
  link: { python?: string; typescript?: string };
  code?: { python?: string; typescript?: string };
  children?: React.ReactNode;
}) => {
  // Prefer TypeScript if available, otherwise fall back to Python
  const isTypeScript = link.typescript !== undefined;
  const referencePath = isTypeScript
    ? "/reference/javascript/scenario/"
    : "/reference/python/scenario/";
  const linkPath = link.typescript ?? link.python;
  const codeText = code?.typescript ?? code?.python;

  return (
    <code className="inline-flex items-center vocs_Code">
      <a
        href={`${referencePath}${linkPath}`}
        target="reference"
        className="underline decoration-dotted decoration-gray-400 hover:no-underline"
      >
        {children ? children : codeText}
      </a>
      {link.typescript && (
        <SuperScriptLink
          link={`/reference/javascript/scenario/${link.typescript}`}
          language="ts"
          className="text-blue-600"
        />
      )}
      {link.python && (
        <SuperScriptLink
          link={`/reference/python/scenario/${link.python}`}
          language="py"
          className="text-green-600"
        />
      )}
    </code>
  );
};

const SuperScriptLink = ({
  link,
  language,
  className,
}: {
  link: string;
  language: string;
  className?: string;
}) => {
  return (
    <sup className={`ml-1 text-xs text-gray-500 ${className}`}>
      [
      <a
        href={link}
        target="reference"
        className="underline decoration-dotted decoration-gray-400 hover:no-underline"
      >
        {language}
      </a>
      ]
    </sup>
  );
};
