"""Remaining research MCP resources: source ACL, lifecycle and public event projection."""
from uuid import uuid4

import pytest
from django.utils import timezone
from django.db import IntegrityError, transaction
from rest_framework.test import APIClient

from plane.db.models import (
    APIToken, FileAsset, Page, Project, ResearchAgentRunEvent, ResearchAgentSession, ResearchChain,
    ResearchChainEvent, ResearchChainNode, ResearchChainNodeTask, ResearchChainSnapshot,
    ResearchExternalReference, ResearchPaperReview, ResearchPaperReviewVersion,
    ResearchProjectProfile, ResearchStageInstance, StageMaterial, StageMaterialVersion,
    StageReviewerAssignment,
)
from plane.research.services.context_tokens import issue_context_token
from plane.research.services.mcp_catalog import TOOL_NAMES
from plane.research.views.agent import _session_visible
from plane.tests.research_fixtures import make_workspace
from plane.tests.contract.app.test_research_machine_access import env, machine, invoke, scoped_client  # noqa: F401

pytestmark = pytest.mark.contract
KINDS = ('paper_review', 'stage_material', 'topic_material', 'external_reference', 'agent_event')
CANARY = 'SYNTHETIC-HIDDEN-MCP-CANARY'


def request_id():
    return 'extended-mcp-' + uuid4().hex


def asset(workspace, project, owner, **overrides):
    return FileAsset.objects.create(**{
        'workspace': workspace, 'project': project, 'user': owner,
        'asset': 'synthetic-metadata/' + uuid4().hex + '.pdf',
        'entity_type': 'RESEARCH_TOPIC_MATERIAL', 'is_uploaded': True, 'size': 321,
        'attributes': {'name': 'synthetic-acceptance.pdf'},
        'storage_metadata': {'secret': CANARY}, **overrides,
    })


def link(e, kind, obj, via='event'):
    ref = {'kind': kind, 'id': str(obj.id)}
    if via == 'task':
        return ResearchChainNodeTask.objects.create(workspace=e['workspace'], chain=e['chain'], node=e['node'],
            title='Explicit reference', resource_type={'stage_material': 'STAGE_MATERIAL', 'external_reference': 'EXTERNAL_REF'}[kind],
            resource_id=obj.id, request_id=request_id(), payload_hash='a'*64)
    if via in ('snapshot', 'source_versions'):
        return ResearchChainSnapshot.objects.create(chain=e['chain'], node=e['node'],
            version=e['node'].snapshots.count()+1, request_id=request_id(),
            **{'resources' if via == 'snapshot' else 'source_versions': [ref]})
    return ResearchChainEvent.objects.create(chain=e['chain'], node=e['node'], event_type='OUTPUT',
        occurred_at=timezone.now(), event_id=request_id(), request_id=request_id(), refs=[ref])


def agent_session(e, *, node=None, user=None, **overrides):
    user = user or e['owner']
    node = node or e['node']
    grant, _ = issue_context_token(workspace=e['workspace'], user=user, profile=e['private_profile'],
        chain_node=node, request_id=request_id(), allowed_tools=sorted(TOOL_NAMES))
    return ResearchAgentSession.objects.create(**{'workspace':e['workspace'],'project':e['private_project'],
        'chain_node':node, 'user':user, 'context_grant':grant,'status':'CLOSED',
        'request_id':request_id(),'payload_hash':'a'*64, **overrides})


def run_event(session, *, seq=1, event_type='OUTPUT', payload=None):
    return ResearchAgentRunEvent.objects.create(session=session, run_id=session.run_id, seq=seq,
        event_type=event_type, payload=payload or {'content':'Public acceptance answer'}, request_id=request_id())


def build_extended(machine):
    """Reusable synthetic fixture builder; does not contact any runtime or file store."""
    e = dict(machine)
    profile = e['private_profile']
    profile.chain_visibility = 'WORKSPACE'
    profile.save(update_fields=['chain_visibility'])
    node = ResearchChainNode.objects.create(chain=e['chain'], node_type='PAPER_WRITING', title='Extended acceptance',
        request_id=request_id(), payload_hash='a'*64)
    e['node'] = node
    other_paper = ResearchChainNode.objects.create(chain=e['chain'], node_type='PAPER_WRITING', title='Other paper node',
        request_id=request_id(), payload_hash='a'*64)
    e['other_paper'] = other_paper
    review = ResearchPaperReview.objects.create(workspace=e['workspace'], chain=e['chain'], node=node,
        owner=e['owner'], status='WAITING_REVIEW', request_id=request_id(), payload_hash='a'*64)
    for version in (1, 2):
        f = asset(e['workspace'], e['private_project'], e['owner'])
        ResearchPaperReviewVersion.objects.create(review=review, version_no=version, asset=f,
            file_name=f'acceptance-v{version}.pdf', content_type='application/pdf', file_size=321,
            change_summary=CANARY, status='SUPERSEDED' if version==1 else 'SUBMITTED',
            submitted_by=e['owner'], submitted_at=timezone.now(), content_hash='a'*64, request_id=request_id())
    review.current_version_no = 2
    review.save(update_fields=['current_version_no'])
    stage = ResearchStageInstance.objects.create(workspace=e['workspace'], project=e['private_project'],
        stage='OPENING', sort_order=1)
    page = Page.objects.create(workspace=e['workspace'], name='Private draft', owned_by=e['owner'],
        description_html=f'<p>{CANARY}</p>')
    material = StageMaterial.objects.create(stage_instance=stage, material_type='RESEARCH_QUESTION', owner=e['owner'],
        visibility='WORKSPACE', status='SUBMITTED', page=page)
    f = asset(e['workspace'], e['private_project'], e['owner'])
    reference = ResearchExternalReference.objects.create(workspace=e['workspace'], system='RAGPORTAL',
        external_type='KNOWLEDGE_ENTRY', external_id=request_id(), title='Synthetic external metadata',
        source_url='http://127.0.0.1:19997/never-fetch', acl_hint={'public':True}, metadata={'credential':CANARY})
    session = agent_session(e)
    event = run_event(session, payload={'content':'Public acceptance answer','reasoning':CANARY,
        'thinking':CANARY, 'headers':{'Authorization':CANARY},'credentials':CANARY,'raw_result':CANARY})
    targets = {'paper_review':review,'stage_material':material,'topic_material':f,
               'external_reference':reference,'agent_event':event}
    e.update(targets=targets, stage=stage, session=session)
    for kind in ('stage_material','topic_material','external_reference'):
        link(e,kind,targets[kind])
    e['reader'] = APIClient()
    reader_key=APIToken.objects.create(user=e['collaborator'],workspace=e['workspace'])
    e['reader'].credentials(HTTP_X_API_KEY=reader_key.token)
    return e


@pytest.fixture
def extended(machine):
    return build_extended(machine)


def resources(e, kind, client=None, **arguments):
    return invoke(e, 'list_research_node_resources', {'node_id':str(e['node'].id),'kind':kind,**arguments},client)


def content(e, kind, obj=None, client=None, **arguments):
    return invoke(e,'read_research_resource',{'node_id':str(e['node'].id),'kind':kind,
        'resource_id':str((obj or e['targets'][kind]).id),**arguments},client)


@pytest.mark.parametrize('kind', KINDS)
def test_visible_resources_and_mcp_agree_without_hidden_fields(extended,kind):
    e=extended
    response=resources(e,kind)
    assert response.status_code==200
    assert [x['id'] for x in response.json()['data']]==[str(e['targets'][kind].id)]
    assert CANARY not in str(response.json())
    mcp=e['api'].post(e['root']+'mcp/',{'jsonrpc':'2.0','id':1,'method':'tools/call',
        'params':{'name':'list_research_node_resources','arguments':{'node_id':str(e['node'].id),'kind':kind}}},format='json')
    assert mcp.json()['result']['structuredContent']['data']==response.json()['data']


@pytest.mark.parametrize('kind', KINDS[:4])
def test_metadata_body_is_explicitly_unsupported(extended,kind):
    response=content(extended,kind)
    assert response.status_code==422
    assert response.json()['error_code']=='unsupported_content'
    assert CANARY not in str(response.json())


@pytest.mark.parametrize('kind', KINDS)
def test_node_grant_rejects_other_node_and_deleted_parent(extended,kind):
    e=extended
    client,_,_=scoped_client(e)
    arguments={'node_id':str(e['other'].id),'kind':kind,'resource_id':str(e['targets'][kind].id)}
    assert invoke(e,'read_research_resource',arguments,client).status_code==404
    obj=e['targets'][kind]
    if kind=='agent_event':
        e['session'].deleted_at=timezone.now(); e['session'].save(update_fields=['deleted_at'])
    else:
        obj.deleted_at=timezone.now(); obj.save(update_fields=['deleted_at'])
    assert resources(e,kind).json()['data']==[]
    assert content(e,kind).status_code==404


@pytest.mark.parametrize('via', ['event','snapshot','source_versions','task'])
@pytest.mark.parametrize('kind', ['stage_material','external_reference'])
def test_explicit_reference_routes_and_unlink_are_live(extended,kind,via):
    e=extended
    # Exclude the original append-only event references using a fresh node.
    e['node']=e['other_paper']
    assert resources(e,kind).json()['data']==[]
    assert content(e,kind).status_code==404
    reference=link(e,kind,e['targets'][kind],via)
    assert [x['id'] for x in resources(e,kind).json()['data']]==[str(e['targets'][kind].id)]
    if via=='task':
        reference.deleted_at=timezone.now(); reference.save(update_fields=['deleted_at'])
        assert resources(e,kind).json()['data']==[]


def test_review_metadata_tracks_real_versions(extended):
    e=extended; review=e['targets']['paper_review']
    assert resources(e,'paper_review').json()['data'][0]['current_version_no']==2
    previous=review.versions.order_by('-version_no').first()
    ResearchPaperReviewVersion.objects.create(review=review, version_no=3,asset=previous.asset,
        file_name='v3.pdf',content_type='application/pdf',file_size=321,change_summary='New draft',
        submitted_by=e['owner'],submitted_at=timezone.now(),content_hash='b'*64,request_id=request_id())
    review.current_version_no=3;review.save(update_fields=['current_version_no'])
    assert resources(e,'paper_review').json()['data'][0]['current_version_no']==3


def test_material_target_acl_and_assigned_reviewer_match_business_rules(extended):
    e=extended; material=e['targets']['stage_material']
    material.visibility='PRIVATE'; material.save(update_fields=['visibility'])
    assert resources(e,'stage_material',e['reader']).json()['data']==[]
    assert content(e,'stage_material',client=e['reader']).status_code==404
    StageReviewerAssignment.objects.create(stage_instance=e['stage'],reviewer=e['collaborator'],reviewer_role='REVIEWER')
    assert [x['id'] for x in resources(e,'stage_material',e['reader']).json()['data']]==[str(material.id)]


def test_deleted_stage_hides_its_material(extended):
    e=extended
    e['stage'].deleted_at=timezone.now();e['stage'].save(update_fields=['deleted_at'])
    assert resources(e,'stage_material').json()['data']==[]
    assert content(e,'stage_material').status_code==404


def test_material_live_draft_does_not_expose_its_page(extended):
    e=extended; material=e['targets']['stage_material']
    material.status='DRAFT'; material.save(update_fields=['status'])
    assert resources(e,'stage_material',e['reader']).json()['data']==[]
    StageMaterialVersion.objects.create(material=material,version_no=1,snapshot={'status':'SUBMITTED'})
    assert len(resources(e,'stage_material',e['reader']).json()['data'])==1
    assert content(e,'stage_material',client=e['reader']).status_code==422


@pytest.mark.parametrize('changes',[{'is_uploaded':False},{'is_deleted':True},{'entity_type':'ISSUE_ATTACHMENT'}])
def test_topic_file_eligibility_is_live(extended,changes):
    e=extended; f=e['targets']['topic_material']
    for k,v in changes.items():setattr(f,k,v)
    f.save(update_fields=list(changes))
    assert resources(e,'topic_material').json()['data']==[]
    assert content(e,'topic_material').status_code==404


@pytest.mark.parametrize('acl,visible',[({},False),({'public':True},True),({'users':['unrelated']},False)])
def test_source_acl_default_deny_even_for_owner(extended,acl,visible):
    e=extended; ref=e['targets']['external_reference']
    ref.acl_hint=acl; ref.save(update_fields=['acl_hint'])
    assert bool(resources(e,'external_reference').json()['data'])==visible
    assert content(e,'external_reference').status_code==(422 if visible else 404)


def test_external_user_unit_and_revocation_are_live(extended):
    e=extended; ref=e['targets']['external_reference']
    for acl in ({'users':[str(e['collaborator'].id)]},{'org_units':[str(e['group'].id)]}):
        ref.acl_hint=acl;ref.save(update_fields=['acl_hint'])
        assert len(resources(e,'external_reference',e['reader']).json()['data'])==1
    ref.acl_hint={};ref.save(update_fields=['acl_hint'])
    assert resources(e,'external_reference',e['reader']).json()['data']==[]
    ref.acl_hint={'public':True};ref.status='REVOKED';ref.save(update_fields=['acl_hint','status'])
    assert resources(e,'external_reference').json()['data']==[]
    assert content(e,'external_reference').status_code==404
    assert all(str(ref.id)!=r['id'] for section in invoke(e,'get_research_node_context',{'node_id':str(e['node'].id)}).json()['data']['evidence_sections'] for ev in section['sample'] for r in ev['refs'])


@pytest.mark.parametrize('state',['UNAVAILABLE','DEGRADED'])
def test_unavailable_reference_remains_explicit_metadata(extended,state):
    ref=extended['targets']['external_reference'];ref.status=state;ref.save(update_fields=['status'])
    row=resources(extended,'external_reference').json()['data'][0]
    assert row['status']==state and row['content_state']=='metadata_only'


@pytest.mark.parametrize('event_type,remote_type',[
    ('REASONING',None),('THINKING',None),('AI_ACTION','assistant.thinking.delta'),
    ('OUTPUT','assistant.thinking.snapshot'),('OUTPUT','unknown.private.event'),
])
def test_internal_events_cannot_disguise_content_as_public(extended,event_type,remote_type):
    e=extended
    hidden=run_event(e['session'],seq=2,event_type=event_type,
        payload={'content':CANARY,**({'remote_type':remote_type} if remote_type else {})})
    assert str(hidden.id) not in str(resources(e,'agent_event').json())
    response=content(e,'agent_event',hidden)
    assert response.status_code==404
    assert CANARY not in str(response.json())


def test_tool_output_does_not_export_raw_results(extended):
    e=extended
    tool=run_event(e['session'],seq=2,event_type='TOOL_CALL',payload={'remote_type':'tool.output',
        'content':CANARY,'summary':CANARY,'name':'public_tool','toolCallId':'tool-1','arguments':CANARY})
    response=content(e,'agent_event',tool)
    assert response.status_code==200
    assert CANARY not in str(response.json())
    assert 'public_tool' in response.json()['data']['text']


def test_public_answer_chunks_and_same_node_other_user_follow_session_policy(extended):
    import json
    e=extended
    other=agent_session(e,user=e['collaborator'])
    assert _session_visible(e['workspace'],e['owner'],other)
    public=run_event(other,payload={'content':'Public long answer '*150})
    args={'node_id':str(e['node'].id),'kind':'agent_event','resource_id':str(public.id),'max_chars':256}
    pieces=[]
    while True:
        response=invoke(e,'read_research_resource',args)
        assert response.status_code==200
        value=response.json();pieces.append(value['data']['text'])
        if not value['page']['has_more']:break
        args['cursor']=value['page']['next_cursor']
    assert len(pieces)>1 and json.loads(''.join(pieces))['content']=='Public long answer '*150
    ids=[x['id'] for x in resources(e,'agent_event').json()['data']]
    assert set(ids)=={str(e['targets']['agent_event'].id),str(public.id)}


def test_denied_scan_can_return_empty_page_then_visible_data(extended):
    e=extended;e['node']=e['other_paper']
    rows=[ResearchExternalReference(workspace=e['workspace'],system='RAGPORTAL',external_type='KNOWLEDGE_ENTRY',
        external_id=request_id(),title='Denied candidate',source_url='http://127.0.0.1:19997/no-fetch',acl_hint={}) for _ in range(201)]
    ResearchExternalReference.objects.bulk_create(rows)
    ResearchChainEvent.objects.create(chain=e['chain'],node=e['node'],event_type='OUTPUT',
        occurred_at=timezone.now(),event_id=request_id(),request_id=request_id(),
        refs=[{'kind':'external_reference','id':str(row.id)} for row in rows])
    visible=ResearchExternalReference.objects.create(workspace=e['workspace'],system='RAGPORTAL',
        external_type='KNOWLEDGE_ENTRY',external_id=request_id(),title='Visible after denied rows',
        source_url='http://127.0.0.1:19997/no-fetch',acl_hint={'public':True})
    link(e,'external_reference',visible)
    response=resources(e,'external_reference',limit=1)
    value=response.json()
    assert value['data']==[] and value['page']['has_more']
    seen=[]
    while value['page']['has_more']:
        value=resources(e,'external_reference',limit=1,cursor=value['page']['next_cursor']).json()
        seen.extend(x['id'] for x in value['data'])
    assert seen==[str(visible.id)]


@pytest.mark.parametrize('kind', KINDS)
def test_forged_cross_workspace_references_never_expose_resources(extended,kind):
    e=extended
    workspace=make_workspace(e['owner'])
    project=Project.objects.create(workspace=workspace,name='Foreign research',identifier=uuid4().hex[:8],network=0)
    profile=ResearchProjectProfile.objects.create(workspace=workspace,project=project,owner=e['owner'],chain_kind='RESEARCH_CHAIN')
    chain=ResearchChain.objects.create(workspace=workspace,project=project,owner=e['owner'],request_id=request_id(),payload_hash='a'*64)
    foreign=build_extended({**e,'workspace':workspace,'private_project':project,'private_profile':profile,'chain':chain})
    target=foreign['targets'][kind]
    link(e,kind,target)
    assert str(target.id) not in str(resources(e,kind).json())
    assert content(e,kind,target).status_code==404
    context=invoke(e,'get_research_node_context',{'node_id':str(e['node'].id)}).json()
    assert str(target.id) not in str(context['data']['evidence_sections'])


@pytest.mark.parametrize('kind', KINDS)
def test_each_resource_kind_pages_and_rejects_cross_kind_cursor(extended,kind):
    e=extended
    if kind=='paper_review':
        second=ResearchPaperReview.objects.create(workspace=e['workspace'],chain=e['chain'],node=e['node'],
            owner=e['owner'],request_id=request_id(),payload_hash='a'*64)
    elif kind=='stage_material':
        second=StageMaterial.objects.create(stage_instance=e['stage'],material_type='HYPOTHESIS',owner=e['owner'],
            visibility='WORKSPACE',status='SUBMITTED')
    elif kind=='topic_material':
        second=asset(e['workspace'],e['private_project'],e['owner'])
    elif kind=='external_reference':
        second=ResearchExternalReference.objects.create(workspace=e['workspace'],system='RAGPORTAL',external_type='KNOWLEDGE_ENTRY',
            external_id=request_id(),title='Second public ref',source_url='http://127.0.0.1:19997/no-fetch',acl_hint={'public':True})
    else:
        second=run_event(e['session'],seq=2,payload={'content':'Second public output'})
    if kind in ('stage_material','topic_material','external_reference'):link(e,kind,second)
    first=resources(e,kind,limit=1).json()
    assert first['page']['has_more']
    cursor=first['page']['next_cursor']
    next_page=resources(e,kind,limit=1,cursor=cursor).json()
    assert {first['data'][0]['id'],next_page['data'][0]['id']}=={str(e['targets'][kind].id),str(second.id)}
    assert not next_page['page']['has_more']
    different=KINDS[(KINDS.index(kind)+1)%len(KINDS)]
    response=resources(e,different,limit=1,cursor=cursor)
    assert response.status_code==400 and response.json()['error_code']=='invalid_cursor'


@pytest.mark.parametrize('resource_type,has_id,valid',[
    ('NONE',False,True),('NONE',True,False),('STAGE_MATERIAL',False,False),('STAGE_MATERIAL',True,True),
])
def test_task_reference_database_constraint(extended,resource_type,has_id,valid):
    e=extended
    args={'workspace':e['workspace'],'chain':e['chain'],'node':e['node'],'title':'Constraint acceptance',
        'resource_type':resource_type,'resource_id':e['targets']['stage_material'].id if has_id else None,
        'request_id':request_id(),'payload_hash':'a'*64}
    if valid:
        ResearchChainNodeTask.objects.create(**args)
    else:
        with pytest.raises(IntegrityError),transaction.atomic():
            ResearchChainNodeTask.objects.create(**args)


def test_agent_session_mismatched_project_is_not_a_node_resource(extended):
    e=extended
    bad=agent_session(e,project=e['public_project'])
    event=run_event(bad,payload={'content':CANARY})
    assert str(event.id) not in str(resources(e,'agent_event').json())
    assert content(e,'agent_event',event).status_code==404
