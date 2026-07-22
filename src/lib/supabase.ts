import { createClient } from "@supabase/supabase-js"
import ws from "ws"
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js"


const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: {
    transport: ws as any
  }
})

export default supabase
