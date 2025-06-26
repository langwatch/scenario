import {
  BotIcon,
  BlocksIcon,
  TheaterIcon,
  NotebookPenIcon,
  ScrollTextIcon,
  BugIcon,
  SettingsIcon,
  TestTubeIcon,
} from "lucide-react";
import { Link } from "./Link";

const icons = {
  bot: () => <BotIcon />,
  blocks: () => <BlocksIcon />,
  theater: () => <TheaterIcon />,
  "notebook-pen": () => <NotebookPenIcon />,
  "scroll-text": () => <ScrollTextIcon />,
  bug: () => <BugIcon />,
  settings: () => <SettingsIcon />,
  "test-tube": () => <TestTubeIcon />,
};

export function BlockLink({
  title,
  description,
  href,
  icon,
}: {
  title: string;
  description: string;
  href: string;
  icon?: keyof typeof icons;
}) {
  return (
    <Link
      href={href}
      className="block w-full rounded-lg bg-background p-4 border border-border hover:border-accent"
    >
      <div className="flex flex-col gap-2">
        {icon && <div className="text-accent">{icons[icon]()}</div>}
        <h3 className="text-[16px] text-heading font-medium">{title}</h3>
        <p className="text-sm">{description}</p>
      </div>
    </Link>
  );
}
