import { useEffect, useState } from "react";

const AGENT_DOCK_DESKTOP_QUERY = "(min-width: 1024px)";

/** 判断当前视口是否支持 Agent Dock 的桌面停靠布局。 */
export function useAgentDockDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setIsDesktop(false);
      return;
    }

    const query = window.matchMedia(AGENT_DOCK_DESKTOP_QUERY);
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isDesktop;
}
