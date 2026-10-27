
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "action_log": {
                  Row: {
                    "action": string,"at": string,"client_action_id": string,"completed_at": string | null,"created_at": string,"device_id": string | null,"id": string,"input": Json | null,"org_id": string,"result": Json | null,"updated_at": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"at"?: string,"client_action_id": string,"completed_at"?: string | null,"created_at"?: string,"device_id"?: string | null,"id"?: string,"input"?: Json | null,"org_id": string,"result"?: Json | null,"updated_at"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "action"?: string,"at"?: string,"client_action_id"?: string,"completed_at"?: string | null,"created_at"?: string,"device_id"?: string | null,"id"?: string,"input"?: Json | null,"org_id"?: string,"result"?: Json | null,"updated_at"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "action_log_device_id_fkey"
      columns: ["device_id"]
isOneToOne: false
      referencedRelation: "device"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "action_log_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"allocation_intake": {
                  Row: {
                    "created_at": string,"id": string,"intake_id": string,"org_id": string,"session_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"intake_id": string,"org_id": string,"session_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"intake_id"?: string,"org_id"?: string,"session_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "allocation_intake_intake_id_fkey"
      columns: ["intake_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "allocation_intake_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "allocation_intake_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "allocation_session"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "allocation_intake_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "allocation_session_fulfillment"
      referencedColumns: ["session_id"]
    }
                  ]
                },"allocation_session": {
                  Row: {
                    "created_at": string,"id": string,"notes": string | null,"number": string,"org_id": string,"party_customer_id": string | null,"split_method": Database["public"]['Enums']["allocation_session_split_method"],"state": Database["public"]['Enums']["allocation_session_state"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"notes"?: string | null,"number": string,"org_id": string,"party_customer_id"?: string | null,"split_method"?: Database["public"]['Enums']["allocation_session_split_method"],"state"?: Database["public"]['Enums']["allocation_session_state"],"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"notes"?: string | null,"number"?: string,"org_id"?: string,"party_customer_id"?: string | null,"split_method"?: Database["public"]['Enums']["allocation_session_split_method"],"state"?: Database["public"]['Enums']["allocation_session_state"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "allocation_session_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "allocation_session_party_customer_id_fkey"
      columns: ["party_customer_id"]
isOneToOne: false
      referencedRelation: "customer"
      referencedColumns: ["id"]
    }
                  ]
                },"asset_tag": {
                  Row: {
                    "code": string,"created_at": string,"current_vessel_id": string | null,"id": string,"org_id": string,"qr": string,"retired_reason": string | null,"state": Database["public"]['Enums']["asset_tag_state"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"created_at"?: string,"current_vessel_id"?: string | null,"id"?: string,"org_id": string,"qr": string,"retired_reason"?: string | null,"state"?: Database["public"]['Enums']["asset_tag_state"],"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"current_vessel_id"?: string | null,"id"?: string,"org_id"?: string,"qr"?: string,"retired_reason"?: string | null,"state"?: Database["public"]['Enums']["asset_tag_state"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "asset_tag_current_vessel_id_fkey"
      columns: ["current_vessel_id"]
isOneToOne: false
      referencedRelation: "vessel"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "asset_tag_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"billing_event": {
                  Row: {
                    "applied": boolean,"created_at": string,"event_created_at": string,"id": string,"kind": string,"org_id": string,"plan": string | null,"reason": string | null,"status": string | null,"stripe_event_id": string,"subscription_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "applied"?: boolean,"created_at"?: string,"event_created_at": string,"id"?: string,"kind": string,"org_id": string,"plan"?: string | null,"reason"?: string | null,"status"?: string | null,"stripe_event_id": string,"subscription_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "applied"?: boolean,"created_at"?: string,"event_created_at"?: string,"id"?: string,"kind"?: string,"org_id"?: string,"plan"?: string | null,"reason"?: string | null,"status"?: string | null,"stripe_event_id"?: string,"subscription_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "billing_event_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"box_plan": {
                  Row: {
                    "box_size_id": string | null,"created_at": string,"fulfillment_state": Database["public"]['Enums']["box_plan_fulfillment_state"],"heavy_allowed": boolean,"id": string,"label_printed_at": string | null,"method": Database["public"]['Enums']["box_plan_method"],"number": string,"org_id": string,"retail_to_box": boolean,"session_id": string,"settlement_id": string,"shipment_id": string | null,"updated_at": string,"weight_lb": number
                  }
                  ComputedFields: never
                  Insert: {
                    "box_size_id"?: string | null,"created_at"?: string,"fulfillment_state"?: Database["public"]['Enums']["box_plan_fulfillment_state"],"heavy_allowed"?: boolean,"id"?: string,"label_printed_at"?: string | null,"method": Database["public"]['Enums']["box_plan_method"],"number": string,"org_id": string,"retail_to_box"?: boolean,"session_id": string,"settlement_id": string,"shipment_id"?: string | null,"updated_at"?: string,"weight_lb"?: number
                  }
                  Update: {
                    "box_size_id"?: string | null,"created_at"?: string,"fulfillment_state"?: Database["public"]['Enums']["box_plan_fulfillment_state"],"heavy_allowed"?: boolean,"id"?: string,"label_printed_at"?: string | null,"method"?: Database["public"]['Enums']["box_plan_method"],"number"?: string,"org_id"?: string,"retail_to_box"?: boolean,"session_id"?: string,"settlement_id"?: string,"shipment_id"?: string | null,"updated_at"?: string,"weight_lb"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "box_plan_box_size_id_fkey"
      columns: ["box_size_id"]
isOneToOne: false
      referencedRelation: "box_size"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "box_plan_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "box_plan_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "allocation_session"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "box_plan_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "allocation_session_fulfillment"
      referencedColumns: ["session_id"]
    },{
      foreignKeyName: "box_plan_settlement_id_session_id_fkey"
      columns: ["settlement_id","session_id"]
isOneToOne: false
      referencedRelation: "settlement"
      referencedColumns: ["id","session_id"]
    },{
      foreignKeyName: "box_plan_shipment_id_fkey"
      columns: ["shipment_id"]
isOneToOne: false
      referencedRelation: "shipment"
      referencedColumns: ["id"]
    }
                  ]
                },"box_size": {
                  Row: {
                    "created_at": string,"dims": NonNullable<Json>,"fee": number,"id": string,"is_active": boolean,"max_lb": number,"name": string,"org_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"dims"?: NonNullable<Json>,"fee"?: number,"id"?: string,"is_active"?: boolean,"max_lb": number,"name": string,"org_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"dims"?: NonNullable<Json>,"fee"?: number,"id"?: string,"is_active"?: boolean,"max_lb"?: number,"name"?: string,"org_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "box_size_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"charge": {
                  Row: {
                    "amount": number | null,"comp_reason": string | null,"created_at": string,"customer_id": string,"description": string | null,"id": string,"intake_line_id": string | null,"kind": Database["public"]['Enums']["charge_kind"],"number": string,"org_id": string,"qty": number,"rate_key": string | null,"settled_payment_id": string | null,"source_id": string | null,"source_type": Database["public"]['Enums']["charge_source_type"],"state": Database["public"]['Enums']["charge_state"],"tax_code": string | null,"unit": string,"unit_price": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount"?: never,"comp_reason"?: string | null,"created_at"?: string,"customer_id": string,"description"?: string | null,"id"?: string,"intake_line_id"?: string | null,"kind": Database["public"]['Enums']["charge_kind"],"number": string,"org_id": string,"qty": number,"rate_key"?: string | null,"settled_payment_id"?: string | null,"source_id"?: string | null,"source_type": Database["public"]['Enums']["charge_source_type"],"state"?: Database["public"]['Enums']["charge_state"],"tax_code"?: string | null,"unit": string,"unit_price": number,"updated_at"?: string
                  }
                  Update: {
                    "amount"?: never,"comp_reason"?: string | null,"created_at"?: string,"customer_id"?: string,"description"?: string | null,"id"?: string,"intake_line_id"?: string | null,"kind"?: Database["public"]['Enums']["charge_kind"],"number"?: string,"org_id"?: string,"qty"?: number,"rate_key"?: string | null,"settled_payment_id"?: string | null,"source_id"?: string | null,"source_type"?: Database["public"]['Enums']["charge_source_type"],"state"?: Database["public"]['Enums']["charge_state"],"tax_code"?: string | null,"unit"?: string,"unit_price"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "charge_customer_id_fkey"
      columns: ["customer_id"]
isOneToOne: false
      referencedRelation: "customer"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "charge_intake_line_id_fkey"
      columns: ["intake_line_id"]
isOneToOne: false
      referencedRelation: "intake_line"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "charge_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "charge_settled_payment_id_fkey"
      columns: ["settled_payment_id"]
isOneToOne: false
      referencedRelation: "payment"
      referencedColumns: ["id"]
    }
                  ]
                },"condition_matrix": {
                  Row: {
                    "condition_code": string,"created_at": string,"id": string,"matrix_key": string,"org_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "condition_code": string,"created_at"?: string,"id"?: string,"matrix_key": string,"org_id": string,"updated_at"?: string
                  }
                  Update: {
                    "condition_code"?: string,"created_at"?: string,"id"?: string,"matrix_key"?: string,"org_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "condition_matrix_org_id_condition_code_fkey"
      columns: ["org_id","condition_code"]
isOneToOne: false
      referencedRelation: "incoming_condition"
      referencedColumns: ["org_id","code"]
    },{
      foreignKeyName: "condition_matrix_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"customer": {
                  Row: {
                    "address": NonNullable<Json>,"created_at": string,"email": string | null,"id": string,"is_lodge_guest": boolean,"last_visit_at": string | null,"lodge_id": string | null,"name": string,"notes": string | null,"org_id": string,"phone": string | null,"phone_digits": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: NonNullable<Json>,"created_at"?: string,"email"?: string | null,"id"?: string,"is_lodge_guest"?: boolean,"last_visit_at"?: string | null,"lodge_id"?: string | null,"name": string,"notes"?: string | null,"org_id": string,"phone"?: string | null,"phone_digits"?: never,"updated_at"?: string
                  }
                  Update: {
                    "address"?: NonNullable<Json>,"created_at"?: string,"email"?: string | null,"id"?: string,"is_lodge_guest"?: boolean,"last_visit_at"?: string | null,"lodge_id"?: string | null,"name"?: string,"notes"?: string | null,"org_id"?: string,"phone"?: string | null,"phone_digits"?: never,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "customer_lodge_id_fkey"
      columns: ["lodge_id"]
isOneToOne: false
      referencedRelation: "lodge"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"device": {
                  Row: {
                    "auth_user_id": string | null,"created_at": string,"id": string,"is_active": boolean,"last_seen_at": string | null,"name": string,"org_id": string,"paired_at": string | null,"pairing_expires_at": string | null,"pairing_key": string,"printer_label_id": string | null,"printer_receipt_id": string | null,"scale_id": string | null,"site_id": string | null,"station": Database["public"]['Enums']["device_station"],"terminal_id": string | null,"token_hash": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth_user_id"?: string | null,"created_at"?: string,"id"?: string,"is_active"?: boolean,"last_seen_at"?: string | null,"name": string,"org_id": string,"paired_at"?: string | null,"pairing_expires_at"?: string | null,"pairing_key"?: string,"printer_label_id"?: string | null,"printer_receipt_id"?: string | null,"scale_id"?: string | null,"site_id"?: string | null,"station": Database["public"]['Enums']["device_station"],"terminal_id"?: string | null,"token_hash"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "auth_user_id"?: string | null,"created_at"?: string,"id"?: string,"is_active"?: boolean,"last_seen_at"?: string | null,"name"?: string,"org_id"?: string,"paired_at"?: string | null,"pairing_expires_at"?: string | null,"pairing_key"?: string,"printer_label_id"?: string | null,"printer_receipt_id"?: string | null,"scale_id"?: string | null,"site_id"?: string | null,"station"?: Database["public"]['Enums']["device_station"],"terminal_id"?: string | null,"token_hash"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "device_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "device_printer_label_id_fkey"
      columns: ["printer_label_id"]
isOneToOne: false
      referencedRelation: "printer"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "device_printer_receipt_id_fkey"
      columns: ["printer_receipt_id"]
isOneToOne: false
      referencedRelation: "printer"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "device_scale_id_fkey"
      columns: ["scale_id"]
isOneToOne: false
      referencedRelation: "scale"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "device_site_id_fkey"
      columns: ["site_id"]
isOneToOne: false
      referencedRelation: "site"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "device_terminal_id_fkey"
      columns: ["terminal_id"]
isOneToOne: false
      referencedRelation: "payment_terminal"
      referencedColumns: ["id"]
    }
                  ]
                },"domain_event": {
                  Row: {
                    "created_at": string,"id": string,"kind": string,"org_id": string,"payload": NonNullable<Json>,"processed_at": string | null,"subject_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"kind": string,"org_id": string,"payload"?: NonNullable<Json>,"processed_at"?: string | null,"subject_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"kind"?: string,"org_id"?: string,"payload"?: NonNullable<Json>,"processed_at"?: string | null,"subject_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "domain_event_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"elevation_grant": {
                  Row: {
                    "created_at": string,"device_id": string | null,"expires_at": string,"id": string,"manager_member_id": string,"org_id": string,"requested_by": string,"token_hash": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"device_id"?: string | null,"expires_at": string,"id"?: string,"manager_member_id": string,"org_id": string,"requested_by": string,"token_hash": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"device_id"?: string | null,"expires_at"?: string,"id"?: string,"manager_member_id"?: string,"org_id"?: string,"requested_by"?: string,"token_hash"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "elevation_grant_device_id_fkey"
      columns: ["device_id"]
isOneToOne: false
      referencedRelation: "device"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "elevation_grant_manager_member_id_fkey"
      columns: ["manager_member_id"]
isOneToOne: false
      referencedRelation: "org_member"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "elevation_grant_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"incoming_condition": {
                  Row: {
                    "code": string,"created_at": string,"id": string,"is_active": boolean,"name": string,"org_id": string,"sort": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"org_id": string,"sort"?: number,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"org_id"?: string,"sort"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "incoming_condition_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"intake": {
                  Row: {
                    "blast_at": string | null,"cancelled_at": string | null,"cooler_location": string | null,"created_at": string,"customer_id": string,"cut_notes": string | null,"dirty_fish": boolean,"dirty_notes": string | null,"done_at": string | null,"estimated_pickup_at": string | null,"fast_pass": boolean,"hold_until": string | null,"id": string,"intake_at": string,"is_lodge_guest": boolean,"locked": boolean,"number": string,"org_id": string,"processing_notes": string | null,"pulled_at": string | null,"rate_card_id": string | null,"reconcile_at": string | null,"ribbing": boolean,"rollstock_at": string | null,"rollstock_done_at": string | null,"site_id": string | null,"split_from_id": string | null,"state": Database["public"]['Enums']["intake_state"],"stored_at": string | null,"total_est_yield_lb": number,"total_incoming_lb": number,"tote_count": number,"updated_at": string,"wave_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "blast_at"?: string | null,"cancelled_at"?: string | null,"cooler_location"?: string | null,"created_at"?: string,"customer_id": string,"cut_notes"?: string | null,"dirty_fish"?: boolean,"dirty_notes"?: string | null,"done_at"?: string | null,"estimated_pickup_at"?: string | null,"fast_pass"?: boolean,"hold_until"?: string | null,"id"?: string,"intake_at"?: string,"is_lodge_guest"?: boolean,"locked"?: boolean,"number": string,"org_id": string,"processing_notes"?: string | null,"pulled_at"?: string | null,"rate_card_id"?: string | null,"reconcile_at"?: string | null,"ribbing"?: boolean,"rollstock_at"?: string | null,"rollstock_done_at"?: string | null,"site_id"?: string | null,"split_from_id"?: string | null,"state"?: Database["public"]['Enums']["intake_state"],"stored_at"?: string | null,"total_est_yield_lb"?: number,"total_incoming_lb"?: number,"tote_count"?: number,"updated_at"?: string,"wave_id"?: string | null
                  }
                  Update: {
                    "blast_at"?: string | null,"cancelled_at"?: string | null,"cooler_location"?: string | null,"created_at"?: string,"customer_id"?: string,"cut_notes"?: string | null,"dirty_fish"?: boolean,"dirty_notes"?: string | null,"done_at"?: string | null,"estimated_pickup_at"?: string | null,"fast_pass"?: boolean,"hold_until"?: string | null,"id"?: string,"intake_at"?: string,"is_lodge_guest"?: boolean,"locked"?: boolean,"number"?: string,"org_id"?: string,"processing_notes"?: string | null,"pulled_at"?: string | null,"rate_card_id"?: string | null,"reconcile_at"?: string | null,"ribbing"?: boolean,"rollstock_at"?: string | null,"rollstock_done_at"?: string | null,"site_id"?: string | null,"split_from_id"?: string | null,"state"?: Database["public"]['Enums']["intake_state"],"stored_at"?: string | null,"total_est_yield_lb"?: number,"total_incoming_lb"?: number,"tote_count"?: number,"updated_at"?: string,"wave_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "intake_customer_id_fkey"
      columns: ["customer_id"]
isOneToOne: false
      referencedRelation: "customer"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_rate_card_id_fkey"
      columns: ["rate_card_id"]
isOneToOne: false
      referencedRelation: "rate_card"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_site_id_fkey"
      columns: ["site_id"]
isOneToOne: false
      referencedRelation: "site"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_split_from_id_fkey"
      columns: ["split_from_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_wave_id_fkey"
      columns: ["wave_id"]
isOneToOne: false
      referencedRelation: "wave"
      referencedColumns: ["id"]
    }
                  ]
                },"intake_line": {
                  Row: {
                    "condition_code": string,"created_at": string,"est_yield_lb": number | null,"fillets_pct": number | null,"id": string,"intake_id": string,"lb": number,"method_code": string,"notes": string | null,"org_id": string,"ribbing": boolean | null,"skin_off": boolean,"sort": number,"species_code": string,"updated_at": string,"yield_factor": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "condition_code": string,"created_at"?: string,"est_yield_lb"?: never,"fillets_pct"?: number | null,"id"?: string,"intake_id": string,"lb"?: number,"method_code": string,"notes"?: string | null,"org_id": string,"ribbing"?: never,"skin_off"?: boolean,"sort"?: number,"species_code": string,"updated_at"?: string,"yield_factor"?: number | null
                  }
                  Update: {
                    "condition_code"?: string,"created_at"?: string,"est_yield_lb"?: never,"fillets_pct"?: number | null,"id"?: string,"intake_id"?: string,"lb"?: number,"method_code"?: string,"notes"?: string | null,"org_id"?: string,"ribbing"?: never,"skin_off"?: boolean,"sort"?: number,"species_code"?: string,"updated_at"?: string,"yield_factor"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "intake_line_intake_id_fkey"
      columns: ["intake_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_line_org_id_condition_code_fkey"
      columns: ["org_id","condition_code"]
isOneToOne: false
      referencedRelation: "incoming_condition"
      referencedColumns: ["org_id","code"]
    },{
      foreignKeyName: "intake_line_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_line_org_id_method_code_fkey"
      columns: ["org_id","method_code"]
isOneToOne: false
      referencedRelation: "processing_method"
      referencedColumns: ["org_id","code"]
    },{
      foreignKeyName: "intake_line_org_id_species_code_fkey"
      columns: ["org_id","species_code"]
isOneToOne: false
      referencedRelation: "species"
      referencedColumns: ["org_id","code"]
    }
                  ]
                },"location": {
                  Row: {
                    "bay": number | null,"capacity": number | null,"code": string,"created_at": string,"depth": Database["public"]['Enums']["location_depth"] | null,"id": string,"is_active": boolean,"kind": Database["public"]['Enums']["location_kind"],"level": number | null,"org_id": string,"qr": string,"row": string | null,"sort_key": string | null,"updated_at": string,"zone": string
                  }
                  ComputedFields: never
                  Insert: {
                    "bay"?: number | null,"capacity"?: number | null,"code": string,"created_at"?: string,"depth"?: Database["public"]['Enums']["location_depth"] | null,"id"?: string,"is_active"?: boolean,"kind": Database["public"]['Enums']["location_kind"],"level"?: number | null,"org_id": string,"qr": string,"row"?: string | null,"sort_key"?: never,"updated_at"?: string,"zone": string
                  }
                  Update: {
                    "bay"?: number | null,"capacity"?: number | null,"code"?: string,"created_at"?: string,"depth"?: Database["public"]['Enums']["location_depth"] | null,"id"?: string,"is_active"?: boolean,"kind"?: Database["public"]['Enums']["location_kind"],"level"?: number | null,"org_id"?: string,"qr"?: string,"row"?: string | null,"sort_key"?: never,"updated_at"?: string,"zone"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "location_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"location_placement": {
                  Row: {
                    "created_at": string,"id": string,"location_id": string,"operator_id": string | null,"org_id": string,"placed_at": string,"station": Database["public"]['Enums']["device_station"],"updated_at": string,"vessel_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"location_id": string,"operator_id"?: string | null,"org_id": string,"placed_at"?: string,"station"?: Database["public"]['Enums']["device_station"],"updated_at"?: string,"vessel_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"location_id"?: string,"operator_id"?: string | null,"org_id"?: string,"placed_at"?: string,"station"?: Database["public"]['Enums']["device_station"],"updated_at"?: string,"vessel_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "location_placement_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "location"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "location_placement_operator_id_fkey"
      columns: ["operator_id"]
isOneToOne: false
      referencedRelation: "org_member"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "location_placement_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "location_placement_vessel_id_fkey"
      columns: ["vessel_id"]
isOneToOne: false
      referencedRelation: "vessel"
      referencedColumns: ["id"]
    }
                  ]
                },"lodge": {
                  Row: {
                    "contact": NonNullable<Json>,"created_at": string,"id": string,"name": string,"org_id": string,"pricing_cap": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "contact"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"name": string,"org_id": string,"pricing_cap"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "contact"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"name"?: string,"org_id"?: string,"pricing_cap"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "lodge_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"org": {
                  Row: {
                    "created_at": string,"id": string,"is_active": boolean,"name": string,"plan": string | null,"plan_changed_at": string | null,"settings": NonNullable<Json>,"slug": string,"stripe_customer_id": string | null,"stripe_subscription_id": string | null,"subscription_status": string | null,"timezone": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"plan"?: string | null,"plan_changed_at"?: string | null,"settings"?: NonNullable<Json>,"slug": string,"stripe_customer_id"?: string | null,"stripe_subscription_id"?: string | null,"subscription_status"?: string | null,"timezone": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"plan"?: string | null,"plan_changed_at"?: string | null,"settings"?: NonNullable<Json>,"slug"?: string,"stripe_customer_id"?: string | null,"stripe_subscription_id"?: string | null,"subscription_status"?: string | null,"timezone"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"org_member": {
                  Row: {
                    "created_at": string,"display_name": string,"id": string,"is_default": boolean,"org_id": string,"pin_hash": string | null,"role": Database["public"]['Enums']["org_member_role"],"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"display_name": string,"id"?: string,"is_default"?: boolean,"org_id": string,"pin_hash"?: string | null,"role": Database["public"]['Enums']["org_member_role"],"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string,"id"?: string,"is_default"?: boolean,"org_id"?: string,"pin_hash"?: string | null,"role"?: Database["public"]['Enums']["org_member_role"],"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "org_member_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"payment": {
                  Row: {
                    "amount": number,"attempt": number,"auth_code": string | null,"card_brand": string | null,"card_last4": string | null,"created_at": string,"created_by": string | null,"customer_id": string | null,"decline_reason": string | null,"entry_mode": Database["public"]['Enums']["payment_entry_mode"] | null,"host_response_code": string | null,"id": string,"idempotency_key": string | null,"number": string,"org_id": string,"provider": Database["public"]['Enums']["payment_terminal_provider"],"provider_ref": string | null,"provider_txn": string | null,"receipt": Json | null,"settled_charge_ids": (string)[],"state": Database["public"]['Enums']["payment_state"],"terminal_id": string | null,"tip": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"attempt"?: number,"auth_code"?: string | null,"card_brand"?: string | null,"card_last4"?: string | null,"created_at"?: string,"created_by"?: string | null,"customer_id"?: string | null,"decline_reason"?: string | null,"entry_mode"?: Database["public"]['Enums']["payment_entry_mode"] | null,"host_response_code"?: string | null,"id"?: string,"idempotency_key"?: string | null,"number": string,"org_id": string,"provider": Database["public"]['Enums']["payment_terminal_provider"],"provider_ref"?: string | null,"provider_txn"?: string | null,"receipt"?: Json | null,"settled_charge_ids"?: (string)[],"state"?: Database["public"]['Enums']["payment_state"],"terminal_id"?: string | null,"tip"?: number,"updated_at"?: string
                  }
                  Update: {
                    "amount"?: number,"attempt"?: number,"auth_code"?: string | null,"card_brand"?: string | null,"card_last4"?: string | null,"created_at"?: string,"created_by"?: string | null,"customer_id"?: string | null,"decline_reason"?: string | null,"entry_mode"?: Database["public"]['Enums']["payment_entry_mode"] | null,"host_response_code"?: string | null,"id"?: string,"idempotency_key"?: string | null,"number"?: string,"org_id"?: string,"provider"?: Database["public"]['Enums']["payment_terminal_provider"],"provider_ref"?: string | null,"provider_txn"?: string | null,"receipt"?: Json | null,"settled_charge_ids"?: (string)[],"state"?: Database["public"]['Enums']["payment_state"],"terminal_id"?: string | null,"tip"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_customer_id_fkey"
      columns: ["customer_id"]
isOneToOne: false
      referencedRelation: "customer"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payment_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payment_terminal_id_fkey"
      columns: ["terminal_id"]
isOneToOne: false
      referencedRelation: "payment_terminal"
      referencedColumns: ["id"]
    }
                  ]
                },"payment_event": {
                  Row: {
                    "at": string,"created_at": string,"id": string,"kind": Database["public"]['Enums']["payment_event_kind"],"org_id": string,"payload": NonNullable<Json>,"payment_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "at"?: string,"created_at"?: string,"id"?: string,"kind": Database["public"]['Enums']["payment_event_kind"],"org_id": string,"payload"?: NonNullable<Json>,"payment_id": string,"updated_at"?: string
                  }
                  Update: {
                    "at"?: string,"created_at"?: string,"id"?: string,"kind"?: Database["public"]['Enums']["payment_event_kind"],"org_id"?: string,"payload"?: NonNullable<Json>,"payment_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_event_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payment_event_payment_id_fkey"
      columns: ["payment_id"]
isOneToOne: false
      referencedRelation: "payment"
      referencedColumns: ["id"]
    }
                  ]
                },"payment_terminal": {
                  Row: {
                    "config": NonNullable<Json>,"created_at": string,"id": string,"is_active": boolean,"name": string,"org_id": string,"provider": Database["public"]['Enums']["payment_terminal_provider"],"secret_ref": string | null,"site_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "config"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"org_id": string,"provider": Database["public"]['Enums']["payment_terminal_provider"],"secret_ref"?: string | null,"site_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "config"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"org_id"?: string,"provider"?: Database["public"]['Enums']["payment_terminal_provider"],"secret_ref"?: string | null,"site_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_terminal_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payment_terminal_site_id_fkey"
      columns: ["site_id"]
isOneToOne: false
      referencedRelation: "site"
      referencedColumns: ["id"]
    }
                  ]
                },"pin_throttle": {
                  Row: {
                    "created_at": string,"failures": number,"id": string,"locked_until": string | null,"org_id": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"failures"?: number,"id"?: string,"locked_until"?: string | null,"org_id": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"failures"?: number,"id"?: string,"locked_until"?: string | null,"org_id"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pin_throttle_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"print_agent": {
                  Row: {
                    "auth_user_id": string | null,"capabilities": NonNullable<Json>,"created_at": string,"id": string,"last_seen_at": string | null,"name": string,"org_id": string,"pairing_expires_at": string | null,"pairing_key": string,"site_id": string | null,"token_hash": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth_user_id"?: string | null,"capabilities"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"last_seen_at"?: string | null,"name": string,"org_id": string,"pairing_expires_at"?: string | null,"pairing_key"?: string,"site_id"?: string | null,"token_hash"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "auth_user_id"?: string | null,"capabilities"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"last_seen_at"?: string | null,"name"?: string,"org_id"?: string,"pairing_expires_at"?: string | null,"pairing_key"?: string,"site_id"?: string | null,"token_hash"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "print_agent_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "print_agent_site_id_fkey"
      columns: ["site_id"]
isOneToOne: false
      referencedRelation: "site"
      referencedColumns: ["id"]
    }
                  ]
                },"print_job": {
                  Row: {
                    "attempts": number,"claimed_by": string | null,"copies": number,"created_at": string,"error": string | null,"id": string,"kind": Database["public"]['Enums']["print_job_kind"],"org_id": string,"payload": string,"payload_type": Database["public"]['Enums']["print_job_payload_type"],"printer_id": string,"source": NonNullable<Json>,"state": Database["public"]['Enums']["print_job_state"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"claimed_by"?: string | null,"copies"?: number,"created_at"?: string,"error"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["print_job_kind"],"org_id": string,"payload": string,"payload_type": Database["public"]['Enums']["print_job_payload_type"],"printer_id": string,"source"?: NonNullable<Json>,"state"?: Database["public"]['Enums']["print_job_state"],"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"claimed_by"?: string | null,"copies"?: number,"created_at"?: string,"error"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["print_job_kind"],"org_id"?: string,"payload"?: string,"payload_type"?: Database["public"]['Enums']["print_job_payload_type"],"printer_id"?: string,"source"?: NonNullable<Json>,"state"?: Database["public"]['Enums']["print_job_state"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "print_job_claimed_by_fkey"
      columns: ["claimed_by"]
isOneToOne: false
      referencedRelation: "print_agent"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "print_job_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "print_job_printer_id_fkey"
      columns: ["printer_id"]
isOneToOne: false
      referencedRelation: "printer"
      referencedColumns: ["id"]
    }
                  ]
                },"printer": {
                  Row: {
                    "address": string | null,"agent_id": string | null,"created_at": string,"id": string,"is_default_for": NonNullable<Json>,"kind": Database["public"]['Enums']["printer_kind"],"name": string,"org_id": string,"site_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"agent_id"?: string | null,"created_at"?: string,"id"?: string,"is_default_for"?: NonNullable<Json>,"kind": Database["public"]['Enums']["printer_kind"],"name": string,"org_id": string,"site_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "address"?: string | null,"agent_id"?: string | null,"created_at"?: string,"id"?: string,"is_default_for"?: NonNullable<Json>,"kind"?: Database["public"]['Enums']["printer_kind"],"name"?: string,"org_id"?: string,"site_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "printer_agent_id_fkey"
      columns: ["agent_id"]
isOneToOne: false
      referencedRelation: "print_agent"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "printer_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "printer_site_id_fkey"
      columns: ["site_id"]
isOneToOne: false
      referencedRelation: "site"
      referencedColumns: ["id"]
    }
                  ]
                },"processing_matrix": {
                  Row: {
                    "condition_code": string,"created_at": string,"id": string,"matrix_key": string,"method_code": string,"org_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "condition_code": string,"created_at"?: string,"id"?: string,"matrix_key": string,"method_code": string,"org_id": string,"updated_at"?: string
                  }
                  Update: {
                    "condition_code"?: string,"created_at"?: string,"id"?: string,"matrix_key"?: string,"method_code"?: string,"org_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "processing_matrix_org_id_condition_code_fkey"
      columns: ["org_id","condition_code"]
isOneToOne: false
      referencedRelation: "incoming_condition"
      referencedColumns: ["org_id","code"]
    },{
      foreignKeyName: "processing_matrix_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "processing_matrix_org_id_method_code_fkey"
      columns: ["org_id","method_code"]
isOneToOne: false
      referencedRelation: "processing_method"
      referencedColumns: ["org_id","code"]
    }
                  ]
                },"processing_method": {
                  Row: {
                    "code": string,"created_at": string,"id": string,"is_active": boolean,"is_exchange": boolean,"kind": Database["public"]['Enums']["processing_method_kind"],"lodge_cappable": boolean,"name": string,"org_id": string,"shorthand": string | null,"sort": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"is_exchange"?: boolean,"kind"?: Database["public"]['Enums']["processing_method_kind"],"lodge_cappable"?: boolean,"name": string,"org_id": string,"shorthand"?: string | null,"sort"?: number,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"is_exchange"?: boolean,"kind"?: Database["public"]['Enums']["processing_method_kind"],"lodge_cappable"?: boolean,"name"?: string,"org_id"?: string,"shorthand"?: string | null,"sort"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "processing_method_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"rate_card": {
                  Row: {
                    "created_at": string,"ends_on": string | null,"id": string,"is_default": boolean,"name": string,"org_id": string,"starts_on": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"ends_on"?: string | null,"id"?: string,"is_default"?: boolean,"name": string,"org_id": string,"starts_on"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"ends_on"?: string | null,"id"?: string,"is_default"?: boolean,"name"?: string,"org_id"?: string,"starts_on"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rate_card_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"rate_card_line": {
                  Row: {
                    "amount": number,"created_at": string,"id": string,"key": string,"org_id": string,"rate_card_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"created_at"?: string,"id"?: string,"key": string,"org_id": string,"rate_card_id": string,"updated_at"?: string
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"id"?: string,"key"?: string,"org_id"?: string,"rate_card_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rate_card_line_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "rate_card_line_rate_card_id_fkey"
      columns: ["rate_card_id"]
isOneToOne: false
      referencedRelation: "rate_card"
      referencedColumns: ["id"]
    }
                  ]
                },"reconcile_line": {
                  Row: {
                    "actual_lb": number,"created_at": string,"expected_lb": number,"id": string,"intake_id": string,"intake_line_id": string,"org_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actual_lb"?: number,"created_at"?: string,"expected_lb"?: number,"id"?: string,"intake_id": string,"intake_line_id": string,"org_id": string,"updated_at"?: string
                  }
                  Update: {
                    "actual_lb"?: number,"created_at"?: string,"expected_lb"?: number,"id"?: string,"intake_id"?: string,"intake_line_id"?: string,"org_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reconcile_line_intake_id_fkey"
      columns: ["intake_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reconcile_line_intake_line_id_fkey"
      columns: ["intake_line_id"]
isOneToOne: true
      referencedRelation: "intake_line"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reconcile_line_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"register_order": {
                  Row: {
                    "created_at": string,"customer_id": string | null,"id": string,"org_id": string,"payment_ids": (string)[],"state": Database["public"]['Enums']["register_order_state"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"customer_id"?: string | null,"id"?: string,"org_id": string,"payment_ids"?: (string)[],"state"?: Database["public"]['Enums']["register_order_state"],"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"customer_id"?: string | null,"id"?: string,"org_id"?: string,"payment_ids"?: (string)[],"state"?: Database["public"]['Enums']["register_order_state"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "register_order_customer_id_fkey"
      columns: ["customer_id"]
isOneToOne: false
      referencedRelation: "customer"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "register_order_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"register_order_line": {
                  Row: {
                    "amount": number | null,"batch_id": string | null,"charge_id": string | null,"created_at": string,"id": string,"org_id": string,"qty": number,"register_order_id": string,"retail_product_id": string | null,"unit_price": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount"?: never,"batch_id"?: string | null,"charge_id"?: string | null,"created_at"?: string,"id"?: string,"org_id": string,"qty"?: number,"register_order_id": string,"retail_product_id"?: string | null,"unit_price": number,"updated_at"?: string
                  }
                  Update: {
                    "amount"?: never,"batch_id"?: string | null,"charge_id"?: string | null,"created_at"?: string,"id"?: string,"org_id"?: string,"qty"?: number,"register_order_id"?: string,"retail_product_id"?: string | null,"unit_price"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "register_order_line_batch_id_fkey"
      columns: ["batch_id"]
isOneToOne: false
      referencedRelation: "storage_pickup_batch"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "register_order_line_charge_id_fkey"
      columns: ["charge_id"]
isOneToOne: false
      referencedRelation: "charge"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "register_order_line_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "register_order_line_register_order_id_fkey"
      columns: ["register_order_id"]
isOneToOne: false
      referencedRelation: "register_order"
      referencedColumns: ["id"]
    }
                  ]
                },"release_audit": {
                  Row: {
                    "box_plan_id": string | null,"created_at": string,"detail": NonNullable<Json>,"event_kind": Database["public"]['Enums']["release_audit_event_kind"],"id": string,"intake_id": string,"org_id": string,"payment_ref": string | null,"released_at": string,"released_by": string | null,"session_id": string | null,"updated_at": string,"vessel_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "box_plan_id"?: string | null,"created_at"?: string,"detail"?: NonNullable<Json>,"event_kind": Database["public"]['Enums']["release_audit_event_kind"],"id"?: string,"intake_id": string,"org_id": string,"payment_ref"?: string | null,"released_at"?: string,"released_by"?: string | null,"session_id"?: string | null,"updated_at"?: string,"vessel_id"?: string | null
                  }
                  Update: {
                    "box_plan_id"?: string | null,"created_at"?: string,"detail"?: NonNullable<Json>,"event_kind"?: Database["public"]['Enums']["release_audit_event_kind"],"id"?: string,"intake_id"?: string,"org_id"?: string,"payment_ref"?: string | null,"released_at"?: string,"released_by"?: string | null,"session_id"?: string | null,"updated_at"?: string,"vessel_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "release_audit_box_plan_id_fkey"
      columns: ["box_plan_id"]
isOneToOne: false
      referencedRelation: "box_plan"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "release_audit_intake_id_fkey"
      columns: ["intake_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "release_audit_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "release_audit_released_by_fkey"
      columns: ["released_by"]
isOneToOne: false
      referencedRelation: "org_member"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "release_audit_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "allocation_session"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "release_audit_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "allocation_session_fulfillment"
      referencedColumns: ["session_id"]
    },{
      foreignKeyName: "release_audit_vessel_id_fkey"
      columns: ["vessel_id"]
isOneToOne: false
      referencedRelation: "vessel"
      referencedColumns: ["id"]
    }
                  ]
                },"scale": {
                  Row: {
                    "agent_id": string | null,"created_at": string,"id": string,"name": string,"org_id": string,"port": string | null,"protocol": Database["public"]['Enums']["scale_protocol"],"site_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id"?: string | null,"created_at"?: string,"id"?: string,"name": string,"org_id": string,"port"?: string | null,"protocol"?: Database["public"]['Enums']["scale_protocol"],"site_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "agent_id"?: string | null,"created_at"?: string,"id"?: string,"name"?: string,"org_id"?: string,"port"?: string | null,"protocol"?: Database["public"]['Enums']["scale_protocol"],"site_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scale_agent_id_fkey"
      columns: ["agent_id"]
isOneToOne: false
      referencedRelation: "print_agent"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scale_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scale_site_id_fkey"
      columns: ["site_id"]
isOneToOne: false
      referencedRelation: "site"
      referencedColumns: ["id"]
    }
                  ]
                },"scale_reading": {
                  Row: {
                    "created_at": string,"id": string,"org_id": string,"read_at": string,"scale_id": string,"stable": boolean,"updated_at": string,"weight_lb": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"org_id": string,"read_at"?: string,"scale_id": string,"stable"?: boolean,"updated_at"?: string,"weight_lb": number
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"org_id"?: string,"read_at"?: string,"scale_id"?: string,"stable"?: boolean,"updated_at"?: string,"weight_lb"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "scale_reading_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scale_reading_scale_id_fkey"
      columns: ["scale_id"]
isOneToOne: false
      referencedRelation: "scale"
      referencedColumns: ["id"]
    }
                  ]
                },"scan_log": {
                  Row: {
                    "created_at": string,"device_id": string | null,"id": string,"intake_id": string | null,"location_id": string | null,"operator_id": string | null,"org_id": string,"parsed": Json | null,"raw": string,"reason": string | null,"result": Database["public"]['Enums']["scan_log_result"],"scanned_at": string,"station": Database["public"]['Enums']["device_station"],"updated_at": string,"vessel_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"device_id"?: string | null,"id"?: string,"intake_id"?: string | null,"location_id"?: string | null,"operator_id"?: string | null,"org_id": string,"parsed"?: Json | null,"raw": string,"reason"?: string | null,"result": Database["public"]['Enums']["scan_log_result"],"scanned_at"?: string,"station": Database["public"]['Enums']["device_station"],"updated_at"?: string,"vessel_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"device_id"?: string | null,"id"?: string,"intake_id"?: string | null,"location_id"?: string | null,"operator_id"?: string | null,"org_id"?: string,"parsed"?: Json | null,"raw"?: string,"reason"?: string | null,"result"?: Database["public"]['Enums']["scan_log_result"],"scanned_at"?: string,"station"?: Database["public"]['Enums']["device_station"],"updated_at"?: string,"vessel_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "scan_log_device_id_fkey"
      columns: ["device_id"]
isOneToOne: false
      referencedRelation: "device"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scan_log_intake_id_fkey"
      columns: ["intake_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scan_log_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "location"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scan_log_operator_id_fkey"
      columns: ["operator_id"]
isOneToOne: false
      referencedRelation: "org_member"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scan_log_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scan_log_vessel_id_fkey"
      columns: ["vessel_id"]
isOneToOne: false
      referencedRelation: "vessel"
      referencedColumns: ["id"]
    }
                  ]
                },"sequence_counter": {
                  Row: {
                    "created_at": string,"id": string,"kind": string,"org_id": string,"updated_at": string,"value": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"kind": string,"org_id": string,"updated_at"?: string,"value"?: number
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"kind"?: string,"org_id"?: string,"updated_at"?: string,"value"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "sequence_counter_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"settlement": {
                  Row: {
                    "amount_total": number,"angler_name": string,"box_fee_total": number,"boxing_token": string,"created_at": string,"customer_id": string | null,"freight_total": number,"id": string,"number": string,"org_id": string,"paid_payment_id": string | null,"processing_share": number,"retail_note": string | null,"session_id": string,"state": Database["public"]['Enums']["settlement_state"],"updated_at": string,"weight_total_lb": number
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_total"?: number,"angler_name": string,"box_fee_total"?: number,"boxing_token"?: string,"created_at"?: string,"customer_id"?: string | null,"freight_total"?: number,"id"?: string,"number": string,"org_id": string,"paid_payment_id"?: string | null,"processing_share"?: number,"retail_note"?: string | null,"session_id": string,"state"?: Database["public"]['Enums']["settlement_state"],"updated_at"?: string,"weight_total_lb"?: number
                  }
                  Update: {
                    "amount_total"?: number,"angler_name"?: string,"box_fee_total"?: number,"boxing_token"?: string,"created_at"?: string,"customer_id"?: string | null,"freight_total"?: number,"id"?: string,"number"?: string,"org_id"?: string,"paid_payment_id"?: string | null,"processing_share"?: number,"retail_note"?: string | null,"session_id"?: string,"state"?: Database["public"]['Enums']["settlement_state"],"updated_at"?: string,"weight_total_lb"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "settlement_customer_id_fkey"
      columns: ["customer_id"]
isOneToOne: false
      referencedRelation: "customer"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlement_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlement_paid_payment_id_fkey"
      columns: ["paid_payment_id"]
isOneToOne: false
      referencedRelation: "payment"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlement_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "allocation_session"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlement_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "allocation_session_fulfillment"
      referencedColumns: ["session_id"]
    }
                  ]
                },"settlement_species": {
                  Row: {
                    "created_at": string,"id": string,"lb": number,"method_code": string,"org_id": string,"settlement_id": string,"species_code": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"lb"?: number,"method_code": string,"org_id": string,"settlement_id": string,"species_code": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"lb"?: number,"method_code"?: string,"org_id"?: string,"settlement_id"?: string,"species_code"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "settlement_species_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlement_species_org_id_method_code_fkey"
      columns: ["org_id","method_code"]
isOneToOne: false
      referencedRelation: "processing_method"
      referencedColumns: ["org_id","code"]
    },{
      foreignKeyName: "settlement_species_org_id_species_code_fkey"
      columns: ["org_id","species_code"]
isOneToOne: false
      referencedRelation: "species"
      referencedColumns: ["org_id","code"]
    },{
      foreignKeyName: "settlement_species_settlement_id_fkey"
      columns: ["settlement_id"]
isOneToOne: false
      referencedRelation: "settlement"
      referencedColumns: ["id"]
    }
                  ]
                },"shipment": {
                  Row: {
                    "blockers": NonNullable<Json>,"box_plan_ids": (string)[],"carrier": string | null,"created_at": string,"customer_id": string | null,"id": string,"is_walkin": boolean,"label_url": string | null,"number": string,"org_id": string,"rate_amount": number | null,"service": string | null,"ship_date": string | null,"ship_to": NonNullable<Json>,"shippo_shipment_id": string | null,"shippo_transaction_id": string | null,"state": Database["public"]['Enums']["shipment_state"],"tracking_number": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "blockers"?: NonNullable<Json>,"box_plan_ids"?: (string)[],"carrier"?: string | null,"created_at"?: string,"customer_id"?: string | null,"id"?: string,"is_walkin"?: boolean,"label_url"?: string | null,"number": string,"org_id": string,"rate_amount"?: number | null,"service"?: string | null,"ship_date"?: string | null,"ship_to"?: NonNullable<Json>,"shippo_shipment_id"?: string | null,"shippo_transaction_id"?: string | null,"state"?: Database["public"]['Enums']["shipment_state"],"tracking_number"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "blockers"?: NonNullable<Json>,"box_plan_ids"?: (string)[],"carrier"?: string | null,"created_at"?: string,"customer_id"?: string | null,"id"?: string,"is_walkin"?: boolean,"label_url"?: string | null,"number"?: string,"org_id"?: string,"rate_amount"?: number | null,"service"?: string | null,"ship_date"?: string | null,"ship_to"?: NonNullable<Json>,"shippo_shipment_id"?: string | null,"shippo_transaction_id"?: string | null,"state"?: Database["public"]['Enums']["shipment_state"],"tracking_number"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "shipment_customer_id_fkey"
      columns: ["customer_id"]
isOneToOne: false
      referencedRelation: "customer"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "shipment_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"site": {
                  Row: {
                    "created_at": string,"id": string,"is_default": boolean,"name": string,"org_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_default"?: boolean,"name": string,"org_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_default"?: boolean,"name"?: string,"org_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "site_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"species": {
                  Row: {
                    "code": string,"created_at": string,"group": Database["public"]['Enums']["species_group"],"id": string,"is_active": boolean,"name": string,"org_id": string,"shorthand": string | null,"skin_off_allowed": boolean,"skin_off_multiplier": number,"sort": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"created_at"?: string,"group": Database["public"]['Enums']["species_group"],"id"?: string,"is_active"?: boolean,"name": string,"org_id": string,"shorthand"?: string | null,"skin_off_allowed"?: boolean,"skin_off_multiplier"?: number,"sort"?: number,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"group"?: Database["public"]['Enums']["species_group"],"id"?: string,"is_active"?: boolean,"name"?: string,"org_id"?: string,"shorthand"?: string | null,"skin_off_allowed"?: boolean,"skin_off_multiplier"?: number,"sort"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "species_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"station_operator_session": {
                  Row: {
                    "created_at": string,"expires_at": string,"id": string,"operator_id": string,"org_id": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"expires_at"?: string,"id"?: string,"operator_id": string,"org_id": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"expires_at"?: string,"id"?: string,"operator_id"?: string,"org_id"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "station_operator_session_operator_id_fkey"
      columns: ["operator_id"]
isOneToOne: false
      referencedRelation: "org_member"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "station_operator_session_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"storage_box": {
                  Row: {
                    "batch_id": string | null,"box_no": number,"created_at": string,"description": string | null,"id": string,"label": string,"org_id": string,"released_at": string | null,"released_by": string | null,"state": Database["public"]['Enums']["storage_box_state"],"storage_intake_id": string,"updated_at": string,"weight_lb": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id"?: string | null,"box_no": number,"created_at"?: string,"description"?: string | null,"id"?: string,"label": string,"org_id": string,"released_at"?: string | null,"released_by"?: string | null,"state"?: Database["public"]['Enums']["storage_box_state"],"storage_intake_id": string,"updated_at"?: string,"weight_lb"?: number | null
                  }
                  Update: {
                    "batch_id"?: string | null,"box_no"?: number,"created_at"?: string,"description"?: string | null,"id"?: string,"label"?: string,"org_id"?: string,"released_at"?: string | null,"released_by"?: string | null,"state"?: Database["public"]['Enums']["storage_box_state"],"storage_intake_id"?: string,"updated_at"?: string,"weight_lb"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "storage_box_batch_id_fkey"
      columns: ["batch_id"]
isOneToOne: false
      referencedRelation: "storage_pickup_batch"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "storage_box_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "storage_box_released_by_fkey"
      columns: ["released_by"]
isOneToOne: false
      referencedRelation: "org_member"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "storage_box_storage_intake_id_fkey"
      columns: ["storage_intake_id"]
isOneToOne: false
      referencedRelation: "storage_intake"
      referencedColumns: ["id"]
    }
                  ]
                },"storage_intake": {
                  Row: {
                    "active_box_count": number,"box_count": number,"created_at": string,"customer_id": string,"id": string,"intake_at": string,"location_id": string | null,"notes": string | null,"number": string,"org_id": string,"site_id": string | null,"state": Database["public"]['Enums']["storage_intake_state"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active_box_count"?: number,"box_count"?: number,"created_at"?: string,"customer_id": string,"id"?: string,"intake_at"?: string,"location_id"?: string | null,"notes"?: string | null,"number": string,"org_id": string,"site_id"?: string | null,"state"?: Database["public"]['Enums']["storage_intake_state"],"updated_at"?: string
                  }
                  Update: {
                    "active_box_count"?: number,"box_count"?: number,"created_at"?: string,"customer_id"?: string,"id"?: string,"intake_at"?: string,"location_id"?: string | null,"notes"?: string | null,"number"?: string,"org_id"?: string,"site_id"?: string | null,"state"?: Database["public"]['Enums']["storage_intake_state"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "storage_intake_customer_id_fkey"
      columns: ["customer_id"]
isOneToOne: false
      referencedRelation: "customer"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "storage_intake_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "location"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "storage_intake_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "storage_intake_site_id_fkey"
      columns: ["site_id"]
isOneToOne: false
      referencedRelation: "site"
      referencedColumns: ["id"]
    }
                  ]
                },"storage_pickup_batch": {
                  Row: {
                    "amount": number,"box_ids": (string)[],"charge_id": string | null,"created_at": string,"id": string,"notes": string,"number": string,"org_id": string,"paid_at": string | null,"payment_id": string | null,"payment_ref": string | null,"rate_per_box_day": number,"release_failed": boolean,"released_at": string | null,"state": Database["public"]['Enums']["storage_pickup_batch_state"],"storage_intake_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"box_ids": (string)[],"charge_id"?: string | null,"created_at"?: string,"id"?: string,"notes"?: string,"number": string,"org_id": string,"paid_at"?: string | null,"payment_id"?: string | null,"payment_ref"?: string | null,"rate_per_box_day": number,"release_failed"?: boolean,"released_at"?: string | null,"state"?: Database["public"]['Enums']["storage_pickup_batch_state"],"storage_intake_id": string,"updated_at"?: string
                  }
                  Update: {
                    "amount"?: number,"box_ids"?: (string)[],"charge_id"?: string | null,"created_at"?: string,"id"?: string,"notes"?: string,"number"?: string,"org_id"?: string,"paid_at"?: string | null,"payment_id"?: string | null,"payment_ref"?: string | null,"rate_per_box_day"?: number,"release_failed"?: boolean,"released_at"?: string | null,"state"?: Database["public"]['Enums']["storage_pickup_batch_state"],"storage_intake_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "storage_pickup_batch_charge_id_fkey"
      columns: ["charge_id"]
isOneToOne: false
      referencedRelation: "charge"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "storage_pickup_batch_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "storage_pickup_batch_payment_id_fkey"
      columns: ["payment_id"]
isOneToOne: false
      referencedRelation: "payment"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "storage_pickup_batch_storage_intake_id_fkey"
      columns: ["storage_intake_id"]
isOneToOne: false
      referencedRelation: "storage_intake"
      referencedColumns: ["id"]
    }
                  ]
                },"tote_tag": {
                  Row: {
                    "created_at": string,"id": string,"intake_id": string,"of_count": number,"org_id": string,"print_job_id": string | null,"printed_at": string | null,"qr": string,"tote_no": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"intake_id": string,"of_count": number,"org_id": string,"print_job_id"?: string | null,"printed_at"?: string | null,"qr": string,"tote_no": number,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"intake_id"?: string,"of_count"?: number,"org_id"?: string,"print_job_id"?: string | null,"printed_at"?: string | null,"qr"?: string,"tote_no"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tote_tag_intake_id_fkey"
      columns: ["intake_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tote_tag_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tote_tag_print_job_id_fkey"
      columns: ["print_job_id"]
isOneToOne: false
      referencedRelation: "print_job"
      referencedColumns: ["id"]
    }
                  ]
                },"vessel": {
                  Row: {
                    "asset_tag_id": string | null,"blast_in_at": string | null,"blast_out_at": string | null,"created_at": string,"emptied_at": string | null,"emptied_by": string | null,"id": string,"intake_id": string,"is_exchange": boolean,"lifecycle_state": Database["public"]['Enums']["vessel_lifecycle_state"],"location_id": string | null,"org_id": string,"release_snapshot": Json | null,"species_summary": string | null,"stored_at": string | null,"updated_at": string,"weight_lb": number
                  }
                  ComputedFields: never
                  Insert: {
                    "asset_tag_id"?: string | null,"blast_in_at"?: string | null,"blast_out_at"?: string | null,"created_at"?: string,"emptied_at"?: string | null,"emptied_by"?: string | null,"id"?: string,"intake_id": string,"is_exchange"?: boolean,"lifecycle_state"?: Database["public"]['Enums']["vessel_lifecycle_state"],"location_id"?: string | null,"org_id": string,"release_snapshot"?: Json | null,"species_summary"?: string | null,"stored_at"?: string | null,"updated_at"?: string,"weight_lb"?: number
                  }
                  Update: {
                    "asset_tag_id"?: string | null,"blast_in_at"?: string | null,"blast_out_at"?: string | null,"created_at"?: string,"emptied_at"?: string | null,"emptied_by"?: string | null,"id"?: string,"intake_id"?: string,"is_exchange"?: boolean,"lifecycle_state"?: Database["public"]['Enums']["vessel_lifecycle_state"],"location_id"?: string | null,"org_id"?: string,"release_snapshot"?: Json | null,"species_summary"?: string | null,"stored_at"?: string | null,"updated_at"?: string,"weight_lb"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "vessel_asset_tag_id_fkey"
      columns: ["asset_tag_id"]
isOneToOne: false
      referencedRelation: "asset_tag"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "vessel_emptied_by_fkey"
      columns: ["emptied_by"]
isOneToOne: false
      referencedRelation: "org_member"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "vessel_intake_id_fkey"
      columns: ["intake_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "vessel_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "location"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "vessel_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"wave": {
                  Row: {
                    "completed_at": string | null,"created_at": string,"id": string,"number": string,"org_id": string,"started_at": string | null,"state": Database["public"]['Enums']["wave_state"],"target_lb": number,"tolerance_lb": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "completed_at"?: string | null,"created_at"?: string,"id"?: string,"number": string,"org_id": string,"started_at"?: string | null,"state"?: Database["public"]['Enums']["wave_state"],"target_lb"?: number,"tolerance_lb"?: number,"updated_at"?: string
                  }
                  Update: {
                    "completed_at"?: string | null,"created_at"?: string,"id"?: string,"number"?: string,"org_id"?: string,"started_at"?: string | null,"state"?: Database["public"]['Enums']["wave_state"],"target_lb"?: number,"tolerance_lb"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wave_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"wave_intake": {
                  Row: {
                    "created_at": string,"id": string,"intake_id": string,"org_id": string,"updated_at": string,"wave_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"intake_id": string,"org_id": string,"updated_at"?: string,"wave_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"intake_id"?: string,"org_id"?: string,"updated_at"?: string,"wave_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wave_intake_intake_id_fkey"
      columns: ["intake_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wave_intake_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wave_intake_wave_id_fkey"
      columns: ["wave_id"]
isOneToOne: false
      referencedRelation: "wave"
      referencedColumns: ["id"]
    }
                  ]
                },"wave_scan": {
                  Row: {
                    "created_at": string,"id": string,"intake_id": string,"operator_id": string | null,"org_id": string,"scanned_at": string,"tote_no": number,"updated_at": string,"wave_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"intake_id": string,"operator_id"?: string | null,"org_id": string,"scanned_at"?: string,"tote_no": number,"updated_at"?: string,"wave_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"intake_id"?: string,"operator_id"?: string | null,"org_id"?: string,"scanned_at"?: string,"tote_no"?: number,"updated_at"?: string,"wave_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wave_scan_intake_id_fkey"
      columns: ["intake_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wave_scan_operator_id_fkey"
      columns: ["operator_id"]
isOneToOne: false
      referencedRelation: "org_member"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wave_scan_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wave_scan_wave_id_fkey"
      columns: ["wave_id"]
isOneToOne: false
      referencedRelation: "wave"
      referencedColumns: ["id"]
    }
                  ]
                },"yield_factor": {
                  Row: {
                    "condition_code": string,"created_at": string,"factor": number,"id": string,"method_code": string,"org_id": string,"species_code": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "condition_code": string,"created_at"?: string,"factor": number,"id"?: string,"method_code": string,"org_id": string,"species_code": string,"updated_at"?: string
                  }
                  Update: {
                    "condition_code"?: string,"created_at"?: string,"factor"?: number,"id"?: string,"method_code"?: string,"org_id"?: string,"species_code"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "yield_factor_org_id_condition_code_fkey"
      columns: ["org_id","condition_code"]
isOneToOne: false
      referencedRelation: "incoming_condition"
      referencedColumns: ["org_id","code"]
    },{
      foreignKeyName: "yield_factor_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "yield_factor_org_id_method_code_fkey"
      columns: ["org_id","method_code"]
isOneToOne: false
      referencedRelation: "processing_method"
      referencedColumns: ["org_id","code"]
    },{
      foreignKeyName: "yield_factor_org_id_species_code_fkey"
      columns: ["org_id","species_code"]
isOneToOne: false
      referencedRelation: "species"
      referencedColumns: ["org_id","code"]
    }
                  ]
                }
          }
          Views: {
            "allocation_session_fulfillment": {
                  Row: {
                    "box_count": number | null,"fulfillment_status": Database["public"]['Enums']["allocation_session_fulfillment_status"] | null,"org_id": string,"planned_count": number | null,"session_id": string
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "allocation_session_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"reconcile_variance": {
                  Row: {
                    "actual_lb": number,"expected_lb": number,"intake_id": string,"intake_line_id": string,"org_id": string,"reconcile_line_id": string,"variance_pct": number | null
                  }
                  ComputedFields: never
                  Insert: {
                           "actual_lb"?: number | null,"expected_lb"?: number | null,"intake_id"?: string | null,"intake_line_id"?: string | null,"org_id"?: string | null,"reconcile_line_id"?: string | null,"variance_pct"?: never
                         }
                        Update: {
                           "actual_lb"?: number | null,"expected_lb"?: number | null,"intake_id"?: string | null,"intake_line_id"?: string | null,"org_id"?: string | null,"reconcile_line_id"?: string | null,"variance_pct"?: never
                         }
                        Relationships: [
                    {
      foreignKeyName: "reconcile_line_intake_id_fkey"
      columns: ["intake_id"]
isOneToOne: false
      referencedRelation: "intake"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reconcile_line_intake_line_id_fkey"
      columns: ["intake_line_id"]
isOneToOne: true
      referencedRelation: "intake_line"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reconcile_line_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"storage_box_days": {
                  Row: {
                    "box_no": number,"days_stored": number | null,"intake_at": string,"label": string,"org_id": string,"released_at": string | null,"state": Database["public"]['Enums']["storage_box_state"],"storage_box_id": string,"storage_intake_id": string
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "storage_box_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "storage_box_storage_intake_id_fkey"
      columns: ["storage_intake_id"]
isOneToOne: false
      referencedRelation: "storage_intake"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "admin_add_member":
{ Args: { "p_client_action_id": string,"p_display_name": string,"p_role": Database["public"]['Enums']["org_member_role"],"p_user_id": string }; Returns: Json
                           },
"admin_create_device":
{ Args: { "p_client_action_id": string,"p_name": string,"p_site_id"?: string,"p_station": Database["public"]['Enums']["device_station"] }; Returns: Json
                           },
"admin_create_lodge":
{ Args: { "p_client_action_id": string,"p_contact"?: Json,"p_name": string,"p_pricing_cap": number }; Returns: Json
                           },
"admin_create_print_agent":
{ Args: { "p_client_action_id": string,"p_name": string,"p_site_id"?: string }; Returns: Json
                           },
"admin_create_rate_card":
{ Args: { "p_client_action_id": string,"p_copy_from"?: string,"p_ends_on": string,"p_name": string,"p_starts_on": string }; Returns: Json
                           },
"admin_create_site":
{ Args: { "p_client_action_id": string,"p_name": string }; Returns: Json
                           },
"admin_customer_duplicates":
{ Args: { "p_limit"?: number }; Returns: {
              "customers": Json,"phone": string
            }[]
                           },
"admin_delete_rate_card":
{ Args: { "p_client_action_id": string,"p_rate_card_id": string }; Returns: Json
                           },
"admin_device_pairing_code":
{ Args: { "p_client_action_id": string,"p_device_id": string }; Returns: {
              "active": boolean,"code": string,"expires_at": string
            }[]
                           },
"admin_list_members":
{ Args: Record<PropertyKey, never>; Returns: {
              "created_at": string,"display_name": string,"email": string,"has_pin": boolean,"id": string,"is_default": boolean,"role": Database["public"]['Enums']["org_member_role"],"user_id": string
            }[]
                           },
"admin_merge_customers":
{ Args: { "p_client_action_id": string,"p_keep_id": string,"p_merge_id": string }; Returns: Json
                           },
"admin_print_agent_pairing_code":
{ Args: { "p_agent_id": string,"p_client_action_id": string }; Returns: {
              "active": boolean,"code": string,"expires_at": string
            }[]
                           },
"admin_rename_site":
{ Args: { "p_client_action_id": string,"p_name": string,"p_site_id": string }; Returns: Json
                           },
"admin_save_printer":
{ Args: { "p_address": string,"p_agent_id": string,"p_client_action_id": string,"p_kind": Database["public"]['Enums']["printer_kind"],"p_name": string,"p_printer_id"?: string,"p_site_id"?: string }; Returns: Json
                           },
"admin_seed_reference":
{ Args: { "p_client_action_id": string,"p_reference": Json }; Returns: Json
                           },
"admin_set_default_site":
{ Args: { "p_client_action_id": string,"p_site_id": string }; Returns: Json
                           },
"admin_set_member_pin":
{ Args: { "p_client_action_id": string,"p_member_id": string,"p_pin": string }; Returns: Json
                           },
"admin_set_member_role":
{ Args: { "p_client_action_id": string,"p_member_id": string,"p_role": Database["public"]['Enums']["org_member_role"] }; Returns: Json
                           },
"admin_set_rate_card_lines":
{ Args: { "p_client_action_id": string,"p_lines": Json,"p_rate_card_id": string }; Returns: Json
                           },
"admin_update_customer":
{ Args: { "p_client_action_id": string,"p_customer_id": string,"p_email": string,"p_name": string,"p_notes": string,"p_phone": string }; Returns: Json
                           },
"admin_update_lodge":
{ Args: { "p_client_action_id": string,"p_contact"?: Json,"p_lodge_id": string,"p_name": string,"p_pricing_cap": number }; Returns: Json
                           },
"admin_update_org":
{ Args: { "p_client_action_id": string,"p_name": string,"p_settings": Json,"p_timezone": string }; Returns: Json
                           },
"admin_update_processing_method":
{ Args: { "p_client_action_id": string,"p_is_active": boolean,"p_lodge_cappable": boolean,"p_method_id": string,"p_name": string }; Returns: Json
                           },
"admin_update_rate_card":
{ Args: { "p_client_action_id": string,"p_ends_on": string,"p_name": string,"p_rate_card_id": string,"p_starts_on": string }; Returns: Json
                           },
"admin_update_species":
{ Args: { "p_client_action_id": string,"p_is_active": boolean,"p_name": string,"p_shorthand": string,"p_sort": number,"p_species_id": string }; Returns: Json
                           },
"advance_wave":
{ Args: { "p_client_action_id": string,"p_operator_session"?: string,"p_wave_id": string }; Returns: Json
                           },
"billing_apply_subscription":
{ Args: { "p_customer_id": string,"p_event_created": string,"p_event_id": string,"p_kind": string,"p_org_hint"?: string,"p_plan": string,"p_status": string,"p_subscription_id": string }; Returns: Json
                           },
"billing_link_customer":
{ Args: { "p_customer_id": string,"p_org_id": string }; Returns: string
                           },
"claim_print_job":
{ Args: { "p_client_action_id": string }; Returns: Json
                           },
"create_customer":
{ Args: { "p_client_action_id": string,"p_email"?: string,"p_name": string,"p_phone": string }; Returns: Json
                           },
"create_org":
{ Args: { "p_client_action_id": string,"p_display_name": string,"p_name": string,"p_reference": Json,"p_site_name"?: string,"p_slug": string,"p_timezone": string }; Returns: Json
                           },
"create_wave":
{ Args: { "p_client_action_id": string,"p_intake_ids": (string)[],"p_operator_session"?: string }; Returns: Json
                           },
"device_bind_auth_user":
{ Args: { "p_device_id": string,"p_user_id": string }; Returns: undefined
                           },
"device_heartbeat":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"device_redeem_pairing":
{ Args: { "p_code": string }; Returns: {
              "auth_user_id": string,"device_id": string,"name": string,"org_id": string,"station": Database["public"]['Enums']["device_station"]
            }[]
                           },
"elevation_mint":
{ Args: { "p_device_id": string,"p_org_id": string,"p_pin": string,"p_user_id": string }; Returns: Json
                           },
"elevation_status":
{ Args: { "p_token": string }; Returns: Json
                           },
"enqueue_print_job":
{ Args: { "p_client_action_id": string,"p_copies"?: number,"p_kind": Database["public"]['Enums']["print_job_kind"],"p_payload": string,"p_payload_type": Database["public"]['Enums']["print_job_payload_type"],"p_printer_id": string,"p_source"?: Json }; Returns: Json
                           },
"finish_print_job":
{ Args: { "p_client_action_id": string,"p_error"?: string,"p_job_id": string }; Returns: Json
                           },
"force_transition":
{ Args: { "p_client_action_id": string,"p_elevation_token"?: string,"p_entity": string,"p_id": string,"p_reason": string,"p_to_state": string }; Returns: Json
                           },
"intake_price_context":
{ Args: { "p_customer_id"?: string,"p_intake_id"?: string }; Returns: Json
                           },
"member_lookup_user":
{ Args: { "p_email": string }; Returns: string
                           },
"my_orgs":
{ Args: Record<PropertyKey, never>; Returns: {
              "is_default": boolean,"name": string,"org_id": string,"role": Database["public"]['Enums']["org_member_role"],"slug": string
            }[]
                           },
"operator_identify":
{ Args: { "p_pin": string }; Returns: Json
                           },
"print_agent_bind_auth_user":
{ Args: { "p_agent_id": string,"p_user_id": string }; Returns: undefined
                           },
"print_agent_heartbeat":
{ Args: { "p_client_action_id": string }; Returns: Json
                           },
"print_agent_redeem_pairing":
{ Args: { "p_code": string }; Returns: {
              "agent_id": string,"auth_user_id": string,"org_id": string
            }[]
                           },
"print_intake_receipt":
{ Args: { "p_client_action_id": string,"p_intake_id": string }; Returns: Json
                           },
"reprint_intake_tote_tags":
{ Args: { "p_client_action_id": string,"p_intake_id": string }; Returns: Json
                           },
"save_intake":
{ Args: { "p_client_action_id": string,"p_payload": Json }; Returns: Json
                           },
"scan_wave_tote":
{ Args: { "p_client_action_id": string,"p_operator_session"?: string,"p_raw": string,"p_wave_id": string }; Returns: Json
                           },
"search_customers":
{ Args: { "p_limit"?: number,"p_org_id": string,"p_q": string }; Returns: {
              "id": string,"is_lodge_guest": boolean,"last_visit_at": string,"lodge_id": string,"lodge_name": string,"name": string,"phone": string
            }[]
                           },
"seed_org_reference":
{ Args: { "p_org_id": string,"p_reference": Json }; Returns: Json
                           },
"set_default_org":
{ Args: { "p_org_id": string }; Returns: undefined
                           },
"set_lodge_guest":
{ Args: { "p_client_action_id": string,"p_customer_id": string,"p_is_lodge_guest": boolean,"p_lodge_id"?: string }; Returns: Json
                           },
"station_identify":
{ Args: { "p_pin": string }; Returns: Json
                           },
"station_scan":
{ Args: { "p_client_action_id": string,"p_operator_session"?: string,"p_parsed": Json,"p_raw": string,"p_reason"?: string,"p_station": Database["public"]['Enums']["device_station"] }; Returns: Json
                           },
"unlock_intake":
{ Args: { "p_client_action_id": string,"p_elevation_token"?: string,"p_intake_id": string,"p_reason"?: string }; Returns: Json
                           }
          }
          Enums: {
            "allocation_session_fulfillment_status": "none"|"pending"|"partial"|"released","allocation_session_split_method": "weight"|"even","allocation_session_state": "draft"|"priced"|"done"|"cancelled","asset_tag_state": "available"|"in_use"|"retired","box_plan_fulfillment_state": "planned"|"packed"|"shipped"|"picked_up","box_plan_method": "air"|"ship"|"willcall","charge_kind": "processing"|"ribbing"|"storage"|"box_fee"|"freight"|"retail"|"adjustment","charge_source_type": "intake"|"storage_batch"|"settlement"|"manual","charge_state": "open"|"settled"|"voided"|"comped","device_station": "intake"|"storage"|"wave"|"rollstock"|"reconcile"|"blast"|"locate"|"allocate"|"boxing"|"register"|"shipping","intake_state": "draft"|"holding"|"processing"|"rollstock"|"reconcile"|"blast_freezer"|"stored"|"done"|"cancelled","location_depth": "F"|"R","location_kind": "rack"|"pallet","org_member_role": "owner"|"manager"|"staff"|"cashier","payment_entry_mode": "chip"|"contactless"|"swipe"|"manual"|"keyed","payment_event_kind": "sale_requested"|"sale_result"|"status_check"|"abort"|"reverse_requested"|"reverse_result"|"refund_requested"|"refund_result"|"error","payment_state": "pending"|"approved"|"declined"|"cancelled"|"indeterminate"|"voided"|"refunded"|"error","payment_terminal_provider": "manual"|"dejavoo_spin"|"stripe_terminal","print_job_kind": "tote_tag"|"receipt"|"storage_label"|"box_label"|"pick_list"|"location_tag"|"shipping_label","print_job_payload_type": "zpl"|"pdf_url","print_job_state": "queued"|"printing"|"done"|"failed","printer_kind": "label_zpl"|"receipt_pdf","processing_method_kind": "service"|"virtual","register_order_state": "open"|"paid"|"void","release_audit_event_kind": "moved"|"finalized"|"restored","scale_protocol": "toledo_8217"|"manual","scan_log_result": "ok"|"rejected","settlement_state": "draft"|"paid","shipment_state": "draft"|"held"|"label_bought"|"shipped"|"cancelled","species_group": "salmon"|"whitefish"|"other"|"byproduct","storage_box_state": "stored"|"released","storage_intake_state": "draft"|"stored"|"partial"|"released"|"cancelled","storage_pickup_batch_state": "pending"|"released"|"void","vessel_lifecycle_state": "occupied"|"emptied"|"void","wave_state": "draft"|"verifying"|"done"|"cancelled"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "allocation_session_fulfillment_status": ["none", "pending", "partial", "released"],"allocation_session_split_method": ["weight", "even"],"allocation_session_state": ["draft", "priced", "done", "cancelled"],"asset_tag_state": ["available", "in_use", "retired"],"box_plan_fulfillment_state": ["planned", "packed", "shipped", "picked_up"],"box_plan_method": ["air", "ship", "willcall"],"charge_kind": ["processing", "ribbing", "storage", "box_fee", "freight", "retail", "adjustment"],"charge_source_type": ["intake", "storage_batch", "settlement", "manual"],"charge_state": ["open", "settled", "voided", "comped"],"device_station": ["intake", "storage", "wave", "rollstock", "reconcile", "blast", "locate", "allocate", "boxing", "register", "shipping"],"intake_state": ["draft", "holding", "processing", "rollstock", "reconcile", "blast_freezer", "stored", "done", "cancelled"],"location_depth": ["F", "R"],"location_kind": ["rack", "pallet"],"org_member_role": ["owner", "manager", "staff", "cashier"],"payment_entry_mode": ["chip", "contactless", "swipe", "manual", "keyed"],"payment_event_kind": ["sale_requested", "sale_result", "status_check", "abort", "reverse_requested", "reverse_result", "refund_requested", "refund_result", "error"],"payment_state": ["pending", "approved", "declined", "cancelled", "indeterminate", "voided", "refunded", "error"],"payment_terminal_provider": ["manual", "dejavoo_spin", "stripe_terminal"],"print_job_kind": ["tote_tag", "receipt", "storage_label", "box_label", "pick_list", "location_tag", "shipping_label"],"print_job_payload_type": ["zpl", "pdf_url"],"print_job_state": ["queued", "printing", "done", "failed"],"printer_kind": ["label_zpl", "receipt_pdf"],"processing_method_kind": ["service", "virtual"],"register_order_state": ["open", "paid", "void"],"release_audit_event_kind": ["moved", "finalized", "restored"],"scale_protocol": ["toledo_8217", "manual"],"scan_log_result": ["ok", "rejected"],"settlement_state": ["draft", "paid"],"shipment_state": ["draft", "held", "label_bought", "shipped", "cancelled"],"species_group": ["salmon", "whitefish", "other", "byproduct"],"storage_box_state": ["stored", "released"],"storage_intake_state": ["draft", "stored", "partial", "released", "cancelled"],"storage_pickup_batch_state": ["pending", "released", "void"],"vessel_lifecycle_state": ["occupied", "emptied", "void"],"wave_state": ["draft", "verifying", "done", "cancelled"]
          }
        }
} as const
