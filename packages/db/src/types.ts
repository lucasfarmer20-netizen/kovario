
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
                },"device": {
                  Row: {
                    "auth_user_id": string | null,"created_at": string,"id": string,"is_active": boolean,"last_seen_at": string | null,"name": string,"org_id": string,"paired_at": string | null,"pairing_expires_at": string | null,"pairing_key": string,"site_id": string | null,"station": Database["public"]['Enums']["device_station"],"token_hash": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth_user_id"?: string | null,"created_at"?: string,"id"?: string,"is_active"?: boolean,"last_seen_at"?: string | null,"name": string,"org_id": string,"paired_at"?: string | null,"pairing_expires_at"?: string | null,"pairing_key"?: string,"site_id"?: string | null,"station": Database["public"]['Enums']["device_station"],"token_hash"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "auth_user_id"?: string | null,"created_at"?: string,"id"?: string,"is_active"?: boolean,"last_seen_at"?: string | null,"name"?: string,"org_id"?: string,"paired_at"?: string | null,"pairing_expires_at"?: string | null,"pairing_key"?: string,"site_id"?: string | null,"station"?: Database["public"]['Enums']["device_station"],"token_hash"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "device_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "device_site_id_fkey"
      columns: ["site_id"]
isOneToOne: false
      referencedRelation: "site"
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
                },"org": {
                  Row: {
                    "created_at": string,"id": string,"is_active": boolean,"name": string,"plan": string | null,"settings": NonNullable<Json>,"slug": string,"stripe_customer_id": string | null,"timezone": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"plan"?: string | null,"settings"?: NonNullable<Json>,"slug": string,"stripe_customer_id"?: string | null,"timezone": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"plan"?: string | null,"settings"?: NonNullable<Json>,"slug"?: string,"stripe_customer_id"?: string | null,"timezone"?: string,"updated_at"?: string
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
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "admin_add_member":
{ Args: { "p_client_action_id": string,"p_display_name": string,"p_role": Database["public"]['Enums']["org_member_role"],"p_user_id": string }; Returns: Json
                           },
"admin_create_device":
{ Args: { "p_client_action_id": string,"p_name": string,"p_site_id"?: string,"p_station": Database["public"]['Enums']["device_station"] }; Returns: Json
                           },
"admin_create_site":
{ Args: { "p_client_action_id": string,"p_name": string }; Returns: Json
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
"admin_rename_site":
{ Args: { "p_client_action_id": string,"p_name": string,"p_site_id": string }; Returns: Json
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
"set_default_org":
{ Args: { "p_org_id": string }; Returns: undefined
                           }
          }
          Enums: {
            "device_station": "intake"|"storage"|"wave"|"rollstock"|"reconcile"|"blast"|"locate"|"allocate"|"boxing"|"register"|"shipping","org_member_role": "owner"|"manager"|"staff"|"cashier"
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
            "device_station": ["intake", "storage", "wave", "rollstock", "reconcile", "blast", "locate", "allocate", "boxing", "register", "shipping"],"org_member_role": ["owner", "manager", "staff", "cashier"]
          }
        }
} as const
