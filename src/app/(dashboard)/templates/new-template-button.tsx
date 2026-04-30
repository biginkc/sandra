"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import { TemplateDialog } from "./template-dialog";

export function NewTemplateButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>New template</Button>
      <TemplateDialog
        mode="create"
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
