import { CustomListDetail } from "@/components/collections/custom-list-detail";

export default async function CustomListDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CustomListDetail listId={id} />;
}
