import { LLMConfig } from "@/types/llm_config";
import { createSlice, PayloadAction } from "@reduxjs/toolkit";

interface UserConfigState {
  role: "admin" | "user" | null
  llm_config: LLMConfig
}

const initialState: UserConfigState = {
  llm_config: {
    LLM: "",
    IMAGE_PROVIDER: "gpt-image-1.5",

  },
  role: null,
}

const userConfigSlice = createSlice({
  name: "userConfig",
  initialState: initialState,
  reducers: {
    setLLMConfig: (state, action: PayloadAction<LLMConfig>) => {
      state.llm_config = action.payload;
    },
    setUserRole: (state, action: PayloadAction<UserConfigState["role"]>) => {
      state.role = action.payload;
    }
  },
});

export const { setLLMConfig, setUserRole } = userConfigSlice.actions;
export default userConfigSlice.reducer;
