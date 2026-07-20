import { useCallback, useEffect, useState } from "react";
import Home from "./components/Home";
import ProjectView from "./components/ProjectView";
import Sidebar from "./components/Sidebar";
import Toasts from "./components/Toasts";
import { useChatStore } from "./store/chatStore";

const SIDEBAR_KEY = "dyla.sidebarCollapsed";

export default function App() {
  const activeChat = useChatStore((s) => s.activeChat);
  const openChat = useChatStore((s) => s.openChat);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === "1");

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const handleOpenChat = useCallback((name: string) => { openChat(name); }, [openChat]);

  return (
    <div id="app-shell">
      <Sidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed((v) => !v)} onOpenChat={handleOpenChat} />
      <main id="main">
        {activeChat ? <ProjectView key={activeChat} name={activeChat} /> : <Home onOpenChat={handleOpenChat} />}
      </main>
      <Toasts />
    </div>
  );
}
