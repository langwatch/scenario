import { useEffect, useState } from "react";
import { GithubStarsScript } from "./components/GithubStars";
import { GoogleTagScript } from "./components/GoogleTagScript";
import { createPortal } from "react-dom";
import { LanguageSelector } from "./components/LanguageSelector";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <>
      <GoogleTagScript trackingId="GTM-KJ4S6Z9C" />
      {mounted &&
        createPortal(
          <LanguageSelector />,
          document.getElementById("language-selector-portal")
        )}
      {children}
      <GithubStarsScript repo="langwatch/scenario" />
    </>
  );
}
