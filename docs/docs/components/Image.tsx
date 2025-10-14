export const Image = ({
  src,
  alt,
  width,
  height,
  style,
}: {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
  style?: React.CSSProperties;
}) => {
  const basePath =
    typeof process !== "undefined"
      ? process.env.BASE_PATH
      : typeof window !== "undefined"
        ? window.location.pathname.startsWith("/scenario")
          ? "/scenario"
          : ""
        : "";

  return (
    <img
      src={`${basePath ?? ""}${src}`}
      alt={alt}
      width={width}
      height={height}
      style={style}
    />
  );
};
