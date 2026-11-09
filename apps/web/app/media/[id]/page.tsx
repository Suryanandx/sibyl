import { MediaPage } from "../../../features/media";

// /media/<id>: one generated item, with its details (docs/media.md).
export const metadata = { title: "Media · Sibyl" };

export default function MediaItemRoute({ params }: { params: { id: string } }) {
  return <MediaPage selectedId={decodeURIComponent(params.id)} />;
}
