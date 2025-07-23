import { GithubStarsScript } from "./components/GithubStars";
import { GoogleTagScript } from "./components/GoogleTagScript";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GoogleTagScript trackingId="GTM-KJ4S6Z9C" />
      {children}
      <GithubStarsScript repo="langwatch/scenario" />
    </>
  );
}
