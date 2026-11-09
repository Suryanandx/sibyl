import { notFound } from "next/navigation";
import { AdminScreen } from "../../../screens/admin/AdminScreen";
import { ADMIN_SECTION_TITLES, ADMIN_SECTIONS, isAdminSection } from "../../../lib/routes";

export function generateStaticParams() {
  return ADMIN_SECTIONS.map((section) => ({ section }));
}

export function generateMetadata({ params }: { params: { section: string } }) {
  return { title: `${isAdminSection(params.section) ? ADMIN_SECTION_TITLES[params.section] : "Admin"} · Admin · Sibyl` };
}

export default function AdminSectionPage({ params }: { params: { section: string } }) {
  if (!isAdminSection(params.section)) notFound();
  return <AdminScreen section={params.section} />;
}
