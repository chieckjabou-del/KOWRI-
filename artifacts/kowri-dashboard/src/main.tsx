import { createRoot } from "react-dom/client";
import App from "./App";
import { installAdminFetch } from "./lib/adminAuth";
import "./index.css";

installAdminFetch();

createRoot(document.getElementById("root")!).render(<App />);
