from pydantic import BaseModel


class PresentationThemeColors(BaseModel):
    primary: str
    background: str
    card: str
    stroke: str
    background_text: str
    primary_text: str
    graph_0: str
    graph_1: str
    graph_2: str
    graph_3: str
    graph_4: str
    graph_5: str
    graph_6: str
    graph_7: str
    graph_8: str
    graph_9: str


class PresentationThemeTextFont(BaseModel):
    name: str
    url: str


class PresentationThemeFonts(BaseModel):
    textFont: PresentationThemeTextFont


class PresentationThemeData(BaseModel):
    colors: PresentationThemeColors
    fonts: PresentationThemeFonts
