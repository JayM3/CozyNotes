const supportedImageTypes = new Map([
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
  ["image/bmp", "image/bmp"],
  ["image/x-ms-bmp", "image/bmp"],
]);

const imageTypeByExtension = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
]);

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function imageType(file: File): string | null {
  const direct = supportedImageTypes.get(file.type.toLowerCase());
  if (direct) return direct;
  const extension = file.name.toLowerCase().split(".").pop();
  return extension ? imageTypeByExtension.get(extension) ?? null : null;
}

export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items)
    .filter(item => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (fromItems.length) return fromItems;
  return Array.from(data.files).filter(file => imageType(file) !== null);
}
