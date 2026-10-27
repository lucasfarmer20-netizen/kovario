"use client";

import { useRouter } from "next/navigation";
import { CustomerSearch } from "@/components/customers/customer-search";
import { createCustomer, searchCustomers } from "./actions";

/** Admin lookup: pick (or create) a customer to open its edit page. */
export function CustomerFinder() {
  const router = useRouter();
  return (
    <CustomerSearch
      autoFocus
      search={searchCustomers}
      create={createCustomer}
      onSelect={(c) => router.push(`/admin/customers/${c.id}`)}
    />
  );
}
