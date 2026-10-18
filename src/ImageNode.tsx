import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Maximize2, Minimize2, TriangleAlert } from "lucide-react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

type ImageAsset = {
  mimeType: string;
  bytes: number[];
};

function ImageNodeView({ node }: NodeViewProps) {
  const assetId = String(node.attrs.assetId ?? "");
  const alt = String(node.attrs.alt ?? "Pasted image");
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    setSource(null);
    setFailed(false);
    setZoomed(false);
    void invoke<ImageAsset>("read_image_asset", { assetId }).then(asset => {
      if (disposed) return;
      const bytes = Uint8Array.from(asset.bytes);
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: asset.mimeType }));
      setSource(objectUrl);
    }).catch(() => {
      if (!disposed) setFailed(true);
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  return <NodeViewWrapper className={`note-image-node${zoomed ? " is-zoomed" : ""}`} data-asset-id={assetId}>
    {source ? <img src={source} alt={alt} draggable={false} onClick={() => setZoomed(value => !value)} /> : (
      <div className="image-load-state" role={failed ? "alert" : "status"}>
        <TriangleAlert size={16} aria-hidden="true" />
        <span>{failed ? "Image unavailable" : "Loading image"}</span>
      </div>
    )}
    {source && <button
      type="button"
      className="image-zoom-control"
      aria-label={zoomed ? "Restore image size" : "Zoom image"}
      title={zoomed ? "Restore image size" : "Zoom image"}
      aria-pressed={zoomed}
      onMouseDown={event => event.preventDefault()}
      onClick={() => setZoomed(value => !value)}
    >{zoomed ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>}
  </NodeViewWrapper>;
}

export const CozyImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  isolating: true,

  addAttributes() {
    return {
      assetId: { default: null },
      alt: { default: "Pasted image" },
    };
  },

  parseHTML() {
    return [{
      tag: "img[data-cozynotes-image]",
      getAttrs: element => ({
        assetId: element.getAttribute("data-asset-id"),
        alt: element.getAttribute("alt") ?? "Pasted image",
      }),
    }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, {
      "data-cozynotes-image": "true",
      "data-asset-id": HTMLAttributes.assetId,
    })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});
