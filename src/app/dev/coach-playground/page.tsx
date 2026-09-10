import { notFound } from "next/navigation";
import CoachPlayground from "./playground";

export default function CoachPlaygroundPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <CoachPlayground />;
}
