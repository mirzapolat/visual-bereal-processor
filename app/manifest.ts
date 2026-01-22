import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BeReal Photo Processor",
    short_name: "BeReal Processor",
    description: "Process BeReal exports into clean, metadata-rich photo sets.",
    start_url: "/",
    display: "standalone",
    background_color: "#0d0f1a",
    theme_color: "#0d0f1a",
    orientation: "portrait",
    categories: ["photo", "productivity", "utilities"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png"
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png"
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      }
    ]
  };
}
