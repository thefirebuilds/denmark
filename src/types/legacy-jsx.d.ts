declare module "*.jsx" {
  import type { ComponentType } from "react";

  const component: ComponentType<Record<string, unknown>>;
  export default component;
}

declare global {
  interface Window {
    __testMailChime?: () => void;
  }
}

export {};
