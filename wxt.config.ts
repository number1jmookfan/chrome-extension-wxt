import { defineConfig } from "wxt"
import tailwindcss from "@tailwindcss/vite";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: "src",
  manifest: {
    permissions: [
      "storage",
      "activeTab",
      "tabs",
      "webNavigation",
      "scripting",
      "downloads"
    ],
    host_permissions: ["<all_urls>"]
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
})
