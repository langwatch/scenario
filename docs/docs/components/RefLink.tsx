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
    <a
      href={`${referencePath}${linkPath}`}
      target="reference"
      className="underline decoration-dotted decoration-gray-400 hover:no-underline"
    >
      {children ? children : <code className="vocs_Code">{codeText}</code>}
    </a>
  );
};
