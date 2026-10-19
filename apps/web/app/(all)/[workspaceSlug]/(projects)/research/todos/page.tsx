import { Navigate, useParams } from "react-router";
export default function LegacyTodoPage() {
  const { workspaceSlug } = useParams();
  return <Navigate replace to={`/${workspaceSlug}/todos`} />;
}
