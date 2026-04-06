import { CreateOutputForm } from "./create-output-form";

export default function NewOutputPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Add Output</h1>
      <CreateOutputForm />
    </div>
  );
}
