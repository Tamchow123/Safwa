import { VocabularyDetail } from "@/components/library/vocabulary-detail";

export default async function VocabularyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <VocabularyDetail idParam={id} />;
}
