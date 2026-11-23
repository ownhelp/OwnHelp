import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `vite build`              -> dist/widget.js      (self-mounting <script> embed, React bundled in)
// `vite build --mode lib`   -> dist/lib/index.js   (importable React component, React external)
export default defineConfig(({ mode }) => {
    if (mode === "lib") {
        return {
            plugins: [react()],
            build: {
                outDir: "dist/lib",
                emptyOutDir: true,
                lib: {
                    entry: "src/index.js",
                    formats: ["es"],
                    fileName: () => "index.js",
                },
                rollupOptions: {
                    external: ["react", "react-dom", "react/jsx-runtime"],
                },
            },
        };
    }

    return {
        plugins: [react()],
        // The IIFE is loaded straight from a <script> tag with no bundler downstream, so React's
        // `process.env.NODE_ENV` checks must be resolved here (and `process` does not exist in a browser).
        define: {
            "process.env.NODE_ENV": JSON.stringify("production"),
        },
        build: {
            outDir: "dist",
            emptyOutDir: true,
            lib: {
                entry: "src/embed.jsx",
                formats: ["iife"],
                name: "SupportWidget",
                fileName: () => "widget.js",
            },
        },
    };
});
