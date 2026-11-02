from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LoginInput(Input):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=128)

    @field_validator("email")
    @classmethod
    def email_format(cls, value):
        value = value.lower()
        if "@" not in value or "." not in value.rsplit("@", 1)[-1] or any(c.isspace() for c in value):
            raise ValueError("请输入有效邮箱")
        return value


class RegisterInput(LoginInput):
    name: str = Field(min_length=1, max_length=80)


class CreateSession(Input):
    title: str = Field(default="新对话", min_length=1, max_length=200)


class PatchSession(Input):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    pinned: bool | None = None


class CreateRun(Input):
    content: str = Field(min_length=1, max_length=100000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=20)
    client_request_id: str = Field(min_length=8, max_length=100)


class ApproveRun(Input):
    approval_id: str
    approved: bool


class PatchSettings(Input):
    base_url: str | None = Field(default=None, max_length=2048)
    model: str | None = Field(default=None, min_length=1, max_length=200)
    api_mode: Literal["responses", "chat_completions"] | None = None


class ToggleExtension(Input):
    enabled: bool


class CreateSkill(Input):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)
    content: str = Field(min_length=1, max_length=100000)


class CreateMCP(Input):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)
    url: str = Field(min_length=8, max_length=2048)
    token_env: str | None = Field(default=None, pattern=r"^MCP_[A-Z0-9_]+_TOKEN$", max_length=100)
